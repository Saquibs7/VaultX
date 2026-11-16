import { describe, expect, it } from 'vitest';
import { BatchQueue, TransactionTracker } from '../src/queue';

describe('queue and transaction tracking', () => {
  it('prevents duplicate credential queue entries and claims only pending work', () => {
    const queue = new BatchQueue();

    queue.enqueue({
      credentialId: 'cred-1',
      issuerId: 'issuer-1',
      documentDigest: '0xabc',
      credentialVersion: 1,
    });

    expect(() =>
      queue.enqueue({
        credentialId: 'cred-1',
        issuerId: 'issuer-2',
        documentDigest: '0xdef',
        credentialVersion: 2,
      })
    ).toThrow('Queue entry already exists for credential cred-1');

    const claimed = queue.claimNext('worker-a');
    expect(claimed?.credentialId).toBe('cred-1');
    expect(claimed?.status).toBe('CLAIMED');
    expect(queue.listPending()).toHaveLength(0);
  });

  it('tracks transaction lifecycle states through confirmation and reorg recovery', () => {
    const tracker = new TransactionTracker();
    const started = tracker.begin('batch-42');

    expect(started.state).toBe('PREPARED');
    expect(tracker.submit('batch-42', '0xabc123')?.state).toBe('SUBMITTED');
    expect(tracker.confirm('batch-42')?.state).toBe('CONFIRMED');
    expect(tracker.reorg('batch-42')?.state).toBe('REORGED');
    expect(tracker.get('batch-42')?.state).toBe('REORGED');
  });
});
