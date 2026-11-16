export type SimulationCredential = {
  credentialId: string;
  arrivedAtMs: number;
  deadlineMs: number;
};

export type PolicyName = 'immediate' | 'fixed-interval' | 'fixed-size' | 'gas-threshold' | 'deadline-aware';

export type PolicyConfig = {
  batchSizeLimit: number;
  maxWaitMs: number;
  hardDeadlineMs: number;
  urgentDeadlineMs: number;
  maxFeeWei: bigint;
};

export type SimulatorConfig = {
  feeProfile: bigint[];
  credentialBursts: SimulationCredential[];
  feeSampleIntervalMs?: number;
  gasUsedPerBatch?: bigint;
};

export type SimulationResult = {
  name: PolicyName;
  totalCostWei: bigint;
  totalAnchored: number;
  metricSummary: {
    totalAnchored: number;
    deadlineViolations: number;
    averageWaitMs: number;
    p95WaitMs: number;
  };
};

export class AnchorPolicySimulator {
  public readonly feeProfile: bigint[];
  public readonly credentialBursts: SimulationCredential[];
  public readonly feeSampleIntervalMs: number;
  public readonly gasUsedPerBatch: bigint;

  constructor({
    feeProfile,
    credentialBursts,
    feeSampleIntervalMs = 1_000,
    gasUsedPerBatch = 100_000n,
  }: SimulatorConfig) {
    if (feeProfile.length === 0) {
      throw new Error('The fee profile must contain at least one observation');
    }
    if (!Number.isFinite(feeSampleIntervalMs) || feeSampleIntervalMs <= 0) {
      throw new Error('The fee sample interval must be a positive number');
    }
    if (gasUsedPerBatch <= 0n) {
      throw new Error('The simulated gas used per batch must be positive');
    }

    this.feeProfile = feeProfile;
    this.credentialBursts = credentialBursts;
    this.feeSampleIntervalMs = feeSampleIntervalMs;
    this.gasUsedPerBatch = gasUsedPerBatch;
  }

  public runPolicy(name: PolicyName, config: PolicyConfig): SimulationResult {
    if (config.batchSizeLimit <= 0 || config.maxWaitMs < 0 || config.hardDeadlineMs <= 0 || config.urgentDeadlineMs < 0) {
      throw new Error('Policy timing and batch limits must be non-negative, with positive batch and hard-deadline limits');
    }

    const arrivals = [...this.credentialBursts].sort((a, b) => a.arrivedAtMs - b.arrivedAtMs);
    const eventTimes = new Set<number>();
    const feeSampleTimes = new Set<number>();
    for (const item of arrivals) {
      if (!Number.isFinite(item.arrivedAtMs) || !Number.isFinite(item.deadlineMs) || item.deadlineMs < item.arrivedAtMs) {
        throw new Error(`Invalid arrival or deadline for credential ${item.credentialId}`);
      }
      eventTimes.add(item.arrivedAtMs);
      eventTimes.add(item.deadlineMs);
      eventTimes.add(item.arrivedAtMs + config.maxWaitMs);
      eventTimes.add(item.arrivedAtMs + config.urgentDeadlineMs);
      eventTimes.add(item.arrivedAtMs + config.hardDeadlineMs);
    }
    this.feeProfile.forEach((_, index) => {
      const timeMs = index * this.feeSampleIntervalMs;
      eventTimes.add(timeMs);
      feeSampleTimes.add(timeMs);
    });

    const queue: Array<SimulationCredential & { hardDeadlineAt: number }> = [];
    const waits: number[] = [];
    const violatedCredentials = new Set<string>();
    let nextArrival = 0;
    let totalCostWei = 0n;
    let totalAnchored = 0;

    const feeAt = (timeMs: number) => {
      const index = Math.min(Math.floor(timeMs / this.feeSampleIntervalMs), this.feeProfile.length - 1);
      return this.feeProfile[Math.max(index, 0)];
    };

    for (const timeMs of [...eventTimes].sort((a, b) => a - b)) {
      let arrivedAtThisTime = false;
      while (nextArrival < arrivals.length && arrivals[nextArrival].arrivedAtMs === timeMs) {
        const credential = arrivals[nextArrival++];
        queue.push({
          ...credential,
          hardDeadlineAt: Math.min(credential.deadlineMs, credential.arrivedAtMs + config.hardDeadlineMs),
        });
        arrivedAtThisTime = true;
      }

      const currentFeeWei = feeAt(timeMs);
      const oldest = queue[0];
      const trigger = queue.length > 0 && (
        (name === 'immediate' && (arrivedAtThisTime || feeSampleTimes.has(timeMs)))
        || (name === 'fixed-interval' && timeMs >= oldest.arrivedAtMs + config.maxWaitMs)
        || (name === 'fixed-size' && (queue.length >= config.batchSizeLimit || timeMs >= oldest.hardDeadlineAt))
        || (name === 'gas-threshold' && currentFeeWei <= config.maxFeeWei)
        || (name === 'deadline-aware' && (
          timeMs >= oldest.arrivedAtMs + config.urgentDeadlineMs
          || timeMs >= oldest.hardDeadlineAt
        ))
      );

      if (trigger && currentFeeWei <= config.maxFeeWei) {
        while (queue.length > 0) {
          const batch = queue.splice(0, config.batchSizeLimit);
          totalAnchored += batch.length;
          waits.push(...batch.map((credential) => Math.max(0, timeMs - credential.arrivedAtMs)));
          for (const credential of batch) {
            if (timeMs > credential.hardDeadlineAt) {
              violatedCredentials.add(credential.credentialId);
            }
          }
          totalCostWei += currentFeeWei * this.gasUsedPerBatch;

          const nextOldest = queue[0];
          if (!nextOldest) break;
          const stillTriggered = name === 'immediate'
            || (name === 'fixed-interval' && timeMs >= nextOldest.arrivedAtMs + config.maxWaitMs)
            || (name === 'fixed-size' && (queue.length >= config.batchSizeLimit || timeMs >= nextOldest.hardDeadlineAt))
            || (name === 'gas-threshold' && currentFeeWei <= config.maxFeeWei)
            || (name === 'deadline-aware' && (
              timeMs >= nextOldest.arrivedAtMs + config.urgentDeadlineMs
              || timeMs >= nextOldest.hardDeadlineAt
            ));
          if (!stillTriggered) break;
        }
      }

      for (const credential of queue) {
        if (timeMs >= credential.hardDeadlineAt) {
          violatedCredentials.add(credential.credentialId);
        }
      }
    }

    const sortedWaits = waits.sort((a, b) => a - b);
    const p95Index = sortedWaits.length > 0 ? Math.ceil(sortedWaits.length * 0.95) - 1 : 0;
    const averageWaitMs = sortedWaits.length > 0
      ? sortedWaits.reduce((sum, wait) => sum + wait, 0) / sortedWaits.length
      : 0;

    return {
      name,
      totalCostWei,
      totalAnchored,
      metricSummary: {
        totalAnchored,
        deadlineViolations: violatedCredentials.size,
        averageWaitMs,
        p95WaitMs: sortedWaits[p95Index] ?? 0,
      },
    };
  }
}

export function evaluatePolicySet(
  simulator: AnchorPolicySimulator,
  policies: Array<{ name: PolicyName; config: PolicyConfig }>,
): SimulationResult[] {
  return policies.map((policy) => simulator.runPolicy(policy.name, policy.config));
}
