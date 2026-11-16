import { describe, expect, it } from 'vitest';

import { TransactionCostLedger, calculateTransactionFee, reconcileReceipt } from '../src/cost-accounting';

describe('transaction cost accounting', () => {
  it('computes exact wei fees using bigint arithmetic and preserves unit conversions', () => {
    const fee = calculateTransactionFee(150000n, 2000000000n);
    expect(fee).toBe(300000000000000n);

    const ledger = new TransactionCostLedger();
    const record = ledger.record({
      batchId: 'batch-1',
      transactionHash: '0xabc',
      gasUsed: 150000n,
      effectiveGasPrice: 2000000000n,
      status: 'CONFIRMED',
      blockNumber: 120n,
      observedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(record.totalFeeWei).toBe(300000000000000n);
    expect(record.totalFeeGwei).toBe('300000');
  });

  it('reconciles missing receipt information without double-counting a confirmed batch', () => {
    const ledger = new TransactionCostLedger();
    const tx = ledger.record({
      batchId: 'batch-2',
      transactionHash: '0xdef',
      gasUsed: 200000n,
      effectiveGasPrice: 1500000000n,
      status: 'PENDING',
      blockNumber: null,
      observedAt: '2026-01-01T00:00:10.000Z',
    });

    expect(reconcileReceipt(tx, null)?.status).toBe('PENDING');
    expect(ledger.get('batch-2')?.status).toBe('PENDING');

    const confirmed = reconcileReceipt(tx, {
      status: 'success',
      gasUsed: 200000n,
      effectiveGasPrice: 1500000000n,
      blockNumber: 121n,
    });

    expect(confirmed?.status).toBe('CONFIRMED');
    expect(confirmed?.totalFeeWei).toBe(300000000000000n);
    expect(confirmed?.status).toBe('CONFIRMED');
  });
});
