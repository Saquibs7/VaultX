export type TransactionStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REPLACED';

export type TransactionReceiptLike = {
  status?: string | null;
  gasUsed?: bigint | number | string | null;
  effectiveGasPrice?: bigint | number | string | null;
  blockNumber?: bigint | number | string | null;
};

export type TransactionCostRecord = {
  batchId: string;
  transactionHash: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  status: TransactionStatus;
  blockNumber: bigint | null;
  observedAt: string;
  totalFeeWei: bigint;
  totalFeeGwei: string;
};

function parseBigInt(value: bigint | number | string | null | undefined, field: string): bigint {
  if (value === null || value === undefined) {
    throw new Error(`${field} is required`);
  }

  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${field} is not a finite number`);
    }
    return BigInt(Math.trunc(value));
  }

  const cleaned = value.trim();
  if (cleaned === '') {
    throw new Error(`${field} is empty`);
  }

  if (/^0x[0-9a-fA-F]+$/.test(cleaned)) {
    return BigInt(cleaned);
  }

  if (/^[0-9]+$/.test(cleaned)) {
    return BigInt(cleaned);
  }

  throw new Error(`${field} is not a valid bigint-compatible value`);
}

export function calculateTransactionFee(gasUsed: bigint | number | string, effectiveGasPrice: bigint | number | string): bigint {
  return parseBigInt(gasUsed, 'gasUsed') * parseBigInt(effectiveGasPrice, 'effectiveGasPrice');
}

export function formatGweiFromWei(value: bigint): string {
  const gwei = value / 1_000_000_000n;
  const remainder = value % 1_000_000_000n;
  const remainderText = remainder.toString().padStart(9, '0');
  return `${gwei}.${remainderText}`.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

export class TransactionCostLedger {
  private readonly ledger = new Map<string, TransactionCostRecord>();

  record(input: {
    batchId: string;
    transactionHash: string;
    gasUsed: bigint | number | string;
    effectiveGasPrice: bigint | number | string;
    status: TransactionStatus;
    blockNumber: bigint | number | string | null;
    observedAt: string;
  }): TransactionCostRecord {
    const gasUsed = parseBigInt(input.gasUsed, 'gasUsed');
    const effectiveGasPrice = parseBigInt(input.effectiveGasPrice, 'effectiveGasPrice');
    const totalFeeWei = calculateTransactionFee(gasUsed, effectiveGasPrice);
    const record: TransactionCostRecord = {
      batchId: input.batchId,
      transactionHash: input.transactionHash,
      gasUsed,
      effectiveGasPrice,
      status: input.status,
      blockNumber: input.blockNumber === null ? null : parseBigInt(input.blockNumber, 'blockNumber'),
      observedAt: input.observedAt,
      totalFeeWei,
      totalFeeGwei: formatGweiFromWei(totalFeeWei),
    };

    this.ledger.set(input.batchId, record);
    return record;
  }

  get(batchId: string): TransactionCostRecord | undefined {
    return this.ledger.get(batchId);
  }
}

export function reconcileReceipt(
  record: TransactionCostRecord,
  receipt: TransactionReceiptLike | null,
): TransactionCostRecord {
  if (!receipt) {
    record.status = 'PENDING';
    return record;
  }

  const status = String(receipt.status ?? '').toLowerCase();
  if (status === 'success' || status === 'confirmed' || status === '1') {
    const gasUsed = parseBigInt(receipt.gasUsed ?? record.gasUsed, 'gasUsed');
    const effectiveGasPrice = parseBigInt(receipt.effectiveGasPrice ?? record.effectiveGasPrice, 'effectiveGasPrice');
    const totalFeeWei = calculateTransactionFee(gasUsed, effectiveGasPrice);

    record.gasUsed = gasUsed;
    record.effectiveGasPrice = effectiveGasPrice;
    record.status = 'CONFIRMED';
    record.blockNumber = receipt.blockNumber === null || receipt.blockNumber === undefined ? record.blockNumber : parseBigInt(receipt.blockNumber, 'blockNumber');
    record.observedAt = new Date().toISOString();
    record.totalFeeWei = totalFeeWei;
    record.totalFeeGwei = formatGweiFromWei(totalFeeWei);
    return record;
  }

  if (status === 'failed' || status === 'reverted' || status === '0') {
    record.status = 'FAILED';
    return record;
  }

  record.status = 'PENDING';
  if (receipt.blockNumber !== undefined && receipt.blockNumber !== null) {
    record.blockNumber = parseBigInt(receipt.blockNumber, 'blockNumber');
  }
  return record;
}
