export type QueuedCredential = {
  credentialId: string;
  issuerId: string;
  documentDigest: string;
  credentialVersion: number;
  createdAt: number;
};

export type SchedulerConfig = {
  batchSizeLimit: number;
  maxWaitMs: number;
  hardDeadlineMs: number;
  urgentDeadlineMs: number;
  maxFeeWei: bigint;
};

export type SchedulerDecision = {
  accepted: boolean;
  reason: string;
  eligible: QueuedCredential[];
  batchSize: number;
  currentBaseFeeWei: bigint;
};

export class DeterministicScheduler {
  public readonly config: SchedulerConfig;

  constructor(config: SchedulerConfig) {
    this.config = config;
  }

  public selectBatch(
    queue: QueuedCredential[],
    context: { currentBaseFeeWei: bigint; staleFee: boolean },
  ): SchedulerDecision {
    const now = Date.now();
    const eligible = [...queue].sort((a, b) => a.createdAt - b.createdAt);

    if (context.staleFee) {
      return {
        accepted: false,
        reason: 'scheduler rejected batch because gas observations are stale',
        eligible: [],
        batchSize: 0,
        currentBaseFeeWei: context.currentBaseFeeWei,
      };
    }

    if (context.currentBaseFeeWei > this.config.maxFeeWei) {
      return {
        accepted: false,
        reason: 'scheduler rejected batch because current base fee exceeds configured budget',
        eligible: [],
        batchSize: 0,
        currentBaseFeeWei: context.currentBaseFeeWei,
      };
    }

    const urgent = eligible
      .filter((item) => now - item.createdAt >= this.config.urgentDeadlineMs)
      .sort((a, b) => b.createdAt - a.createdAt);

    const dueSoon = eligible
      .filter((item) => now - item.createdAt >= this.config.maxWaitMs)
      .sort((a, b) => b.createdAt - a.createdAt);

    const baseSelection = urgent.length > 0
      ? [...urgent, ...eligible.filter((item) => !urgent.some((candidate) => candidate.credentialId === item.credentialId))]
      : dueSoon.length > 0
        ? [...dueSoon, ...eligible.filter((item) => !dueSoon.some((candidate) => candidate.credentialId === item.credentialId))]
        : eligible;

    const batch = baseSelection.slice(0, this.config.batchSizeLimit);
    const shouldAccept = batch.length > 0 && batch.length <= this.config.batchSizeLimit;

    if (!shouldAccept) {
      return {
        accepted: false,
        reason: 'no eligible credentials for deterministic batching',
        eligible: [],
        batchSize: 0,
        currentBaseFeeWei: context.currentBaseFeeWei,
      };
    }

    const oldestAge = batch.length > 0 ? now - batch[0].createdAt : 0;
    const reason = oldestAge >= this.config.hardDeadlineMs
      ? 'deadline-triggered batch selection with hard deadline guardrail enforced'
      : 'deadline-aware deterministic batch selection';

    return {
      accepted: true,
      reason,
      eligible: batch,
      batchSize: batch.length,
      currentBaseFeeWei: context.currentBaseFeeWei,
    };
  }
}
