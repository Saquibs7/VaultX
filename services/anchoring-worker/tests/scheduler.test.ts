import { describe, expect, it } from 'vitest';

import { DeterministicScheduler } from '../src/scheduler';

describe('deterministic scheduler', () => {
  it('prefers urgent credentials and enforces the hard deadline guardrail', () => {
    const scheduler = new DeterministicScheduler({
      batchSizeLimit: 2,
      maxWaitMs: 2000,
      hardDeadlineMs: 5000,
      urgentDeadlineMs: 1000,
      maxFeeWei: 2_000_000_000_000n,
    });

    const queued = [
      { credentialId: 'later', issuerId: 'issuer-1', documentDigest: '0xaaa', credentialVersion: 1, createdAt: Date.now() - 3000 },
      { credentialId: 'urgent', issuerId: 'issuer-1', documentDigest: '0xbbb', credentialVersion: 1, createdAt: Date.now() - 2000 },
    ];

    const decision = scheduler.selectBatch(queued, { currentBaseFeeWei: 1_000_000_000n, staleFee: false });
    expect(decision.eligible.map((item) => item.credentialId)).toEqual(['urgent', 'later']);
    expect(decision.reason).toContain('deadline');
    expect(decision.accepted).toBe(true);
  });

  it('declines a batch when gas observations are stale or over budget', () => {
    const scheduler = new DeterministicScheduler({
      batchSizeLimit: 3,
      maxWaitMs: 2000,
      hardDeadlineMs: 5000,
      urgentDeadlineMs: 1500,
      maxFeeWei: 500n,
    });

    const queued = [
      { credentialId: 'slow', issuerId: 'issuer-1', documentDigest: '0xccc', credentialVersion: 1, createdAt: Date.now() - 4000 },
    ];

    const decision = scheduler.selectBatch(queued, { currentBaseFeeWei: 1_000n, staleFee: true });
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain('stale');
    expect(decision.eligible).toEqual([]);
  });
});
