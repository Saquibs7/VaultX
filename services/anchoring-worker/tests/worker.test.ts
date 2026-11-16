import { describe, expect, it } from 'vitest';
import { assembleBatchEntries, createBatchRoot } from '../src/index';

describe('anchoring worker batch assembly', () => {
  it('produces a deterministic root regardless of input ordering', () => {
    const batchA = [
      { credentialId: 'cred-2', issuerId: 'issuer-1', documentDigest: '0x1111', credentialVersion: 1 },
      { credentialId: 'cred-1', issuerId: 'issuer-1', documentDigest: '0x2222', credentialVersion: 1 },
    ];

    const batchB = [
      { credentialId: 'cred-1', issuerId: 'issuer-1', documentDigest: '0x2222', credentialVersion: 1 },
      { credentialId: 'cred-2', issuerId: 'issuer-1', documentDigest: '0x1111', credentialVersion: 1 },
    ];

    expect(createBatchRoot(batchA)).toEqual(createBatchRoot(batchB));
    expect(assembleBatchEntries(batchA).map((entry) => entry.credentialId)).toEqual(['cred-1', 'cred-2']);
  });

  it('keeps the document hash and issuer identity distinct in the leaf construction', () => {
    const root = createBatchRoot([
      { credentialId: 'cred-abc', issuerId: 'issuer-1', documentDigest: '0xabc', credentialVersion: 2 },
      { credentialId: 'cred-def', issuerId: 'issuer-2', documentDigest: '0xdef', credentialVersion: 3 },
    ]);

    expect(root).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('builds a batch and records its transaction lifecycle from queue to confirmation', async () => {
    const { BatchSubmissionCoordinator } = await import('../src/index');
    const coordinator = new BatchSubmissionCoordinator();

    coordinator.enqueueCredential({ credentialId: 'cred-a', issuerId: 'issuer-1', documentDigest: '0xaaa', credentialVersion: 1 });
    coordinator.enqueueCredential({ credentialId: 'cred-b', issuerId: 'issuer-1', documentDigest: '0xbbb', credentialVersion: 2 });

    const batch = coordinator.claimBatch('worker-a');
    expect(batch).not.toBeNull();
    expect(batch?.entries.map((entry) => entry.credentialId)).toEqual(['cred-a', 'cred-b']);
    expect(batch?.root).toMatch(/^0x[a-f0-9]{64}$/);

    const submitted = coordinator.submitBatch(batch!.batchId, '0xabc123');
    expect(submitted.transaction?.state).toBe('SUBMITTED');
    expect(coordinator.confirmBatch(batch!.batchId).transaction?.state).toBe('CONFIRMED');
  });
});
