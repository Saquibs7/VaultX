import { describe, expect, it } from 'vitest';

import { AnchorPolicySimulator, evaluatePolicySet } from '../src/simulator';

describe('workload simulator', () => {
  it('compares deterministic policies on the same workload and computes the expected metrics', () => {
    const simulator = new AnchorPolicySimulator({
      feeProfile: [300n, 100n, 150n, 150n],
      credentialBursts: [
        { credentialId: 'a', arrivedAtMs: 0, deadlineMs: 5000 },
        { credentialId: 'b', arrivedAtMs: 0, deadlineMs: 6000 },
        { credentialId: 'c', arrivedAtMs: 1000, deadlineMs: 7000 },
      ],
    });

    const config = { batchSizeLimit: 2, maxWaitMs: 2000, hardDeadlineMs: 5000, urgentDeadlineMs: 1000, maxFeeWei: 200n };
    const result = simulator.runPolicy('immediate', config);
    expect(result.totalCostWei).toBeGreaterThan(0n);
    expect(result.metricSummary.totalAnchored).toBe(3);
    expect(result.metricSummary.deadlineViolations).toBe(0);

    const comparison = evaluatePolicySet(simulator, [
      { name: 'immediate', config },
      { name: 'fixed-interval', config },
    ]);

    expect(comparison.length).toBe(2);
    expect(comparison[0].name).toBe('immediate');
    expect(comparison[1].metricSummary.averageWaitMs).toBeGreaterThan(comparison[0].metricSummary.averageWaitMs);
    expect(comparison[1].totalCostWei).toBeGreaterThan(comparison[0].totalCostWei);
  });

  it('records credentials that miss their deadline when fees remain over budget', () => {
    const simulator = new AnchorPolicySimulator({
      feeProfile: [500n, 500n],
      credentialBursts: [{ credentialId: 'late', arrivedAtMs: 0, deadlineMs: 1000 }],
    });

    const result = simulator.runPolicy('gas-threshold', {
      batchSizeLimit: 2,
      maxWaitMs: 2000,
      hardDeadlineMs: 5000,
      urgentDeadlineMs: 1000,
      maxFeeWei: 200n,
    });

    expect(result.metricSummary.totalAnchored).toBe(0);
    expect(result.metricSummary.deadlineViolations).toBe(1);
    expect(result.totalCostWei).toBe(0n);
  });
});
