export type QueueStatus = 'PENDING' | 'CLAIMED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
export type TransactionState = 'PREPARED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'REORGED';

export type QueueItem = {
  credentialId: string;
  issuerId: string;
  documentDigest: string;
  credentialVersion: number;
  status: QueueStatus;
  claimedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type TransactionRecord = {
  batchId: string;
  transactionHash?: string;
  state: TransactionState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
};

export class BatchQueue {
  private readonly queue = new Map<string, QueueItem>();

  enqueue(item: Omit<QueueItem, 'status' | 'createdAt' | 'updatedAt'>): QueueItem {
    const now = new Date().toISOString();
    const duplicate = this.queue.get(item.credentialId);
    if (duplicate) {
      throw new Error(`Queue entry already exists for credential ${item.credentialId}`);
    }

    const entry: QueueItem = {
      ...item,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    };

    this.queue.set(item.credentialId, entry);
    return entry;
  }

  claimNext(workerId: string): QueueItem | null {
    const next = [...this.queue.values()].find((item) => item.status === 'PENDING');
    if (!next) {
      return null;
    }

    next.status = 'CLAIMED';
    next.claimedBy = workerId;
    next.updatedAt = new Date().toISOString();
    return { ...next };
  }

  markSubmitted(credentialId: string): QueueItem | null {
    const item = this.queue.get(credentialId);
    if (!item) {
      return null;
    }

    item.status = 'SUBMITTED';
    item.updatedAt = new Date().toISOString();
    return { ...item };
  }

  markConfirmed(credentialId: string): QueueItem | null {
    const item = this.queue.get(credentialId);
    if (!item) {
      return null;
    }

    item.status = 'CONFIRMED';
    item.updatedAt = new Date().toISOString();
    item.claimedBy = undefined;
    return { ...item };
  }

  markFailed(credentialId: string, reason: string): QueueItem | null {
    const item = this.queue.get(credentialId);
    if (!item) {
      return null;
    }

    item.status = 'FAILED';
    item.updatedAt = new Date().toISOString();
    item.claimedBy = undefined;
    return { ...item, failureReason: reason } as QueueItem & { failureReason?: string };
  }

  listPending(): QueueItem[] {
    return [...this.queue.values()].filter((item) => item.status === 'PENDING');
  }
}

export class TransactionTracker {
  private readonly transactions = new Map<string, TransactionRecord>();

  begin(batchId: string): TransactionRecord {
    const now = new Date().toISOString();
    const record: TransactionRecord = {
      batchId,
      state: 'PREPARED',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.transactions.set(batchId, record);
    return record;
  }

  submit(batchId: string, transactionHash: string): TransactionRecord | null {
    const record = this.transactions.get(batchId);
    if (!record) {
      return null;
    }

    record.state = 'SUBMITTED';
    record.transactionHash = transactionHash;
    record.attempts += 1;
    record.updatedAt = new Date().toISOString();
    return { ...record };
  }

  confirm(batchId: string): TransactionRecord | null {
    const record = this.transactions.get(batchId);
    if (!record) {
      return null;
    }

    record.state = 'CONFIRMED';
    record.updatedAt = new Date().toISOString();
    return { ...record };
  }

  fail(batchId: string, reason: string): TransactionRecord | null {
    const record = this.transactions.get(batchId);
    if (!record) {
      return null;
    }

    record.state = 'FAILED';
    record.failureReason = reason;
    record.updatedAt = new Date().toISOString();
    return { ...record };
  }

  reorg(batchId: string): TransactionRecord | null {
    const record = this.transactions.get(batchId);
    if (!record) {
      return null;
    }

    record.state = 'REORGED';
    record.updatedAt = new Date().toISOString();
    return { ...record };
  }

  get(batchId: string): TransactionRecord | undefined {
    return this.transactions.get(batchId);
  }
}
