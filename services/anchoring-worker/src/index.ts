import { createLeaf, createMerkleRoot, hashStringId } from '@verified-document-vault/crypto-protocol';
import { Interface, JsonRpcProvider, Wallet, type ContractRunner } from 'ethers';
import { z } from 'zod';

import { BatchQueue, TransactionTracker, type QueueItem, type TransactionRecord } from './queue.js';

export * from './queue.js';
export * from './cost-accounting.js';
export * from './scheduler.js';
export * from './simulator.js';

export const queueEntrySchema = z.object({
  credentialId: z.string().min(1),
  issuerId: z.string().min(1),
  documentDigest: z.string().min(1),
  credentialVersion: z.union([z.number(), z.bigint()]).refine((value) => Number(value) >= 1),
});

export type QueueEntry = z.infer<typeof queueEntrySchema>;

export function assembleBatchEntries(entries: QueueEntry[]): QueueEntry[] {
  return [...entries]
    .map((entry) => queueEntrySchema.parse(entry))
    .sort((a, b) => a.credentialId.localeCompare(b.credentialId));
}

function normalizeToBytes32(value: string): string {
  const normalized = value.startsWith('0x') ? value : `0x${value}`;
  if (/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    return normalized.toLowerCase();
  }
  return hashStringId(value).toLowerCase();
}

export function createBatchRoot(entries: QueueEntry[]): string {
  const bundled = assembleBatchEntries(entries);
  const leaves = bundled.map((entry) =>
    createLeaf({
      credentialIdHash: hashStringId(entry.credentialId),
      documentDigest: normalizeToBytes32(entry.documentDigest),
      issuerIdHash: hashStringId(entry.issuerId),
      credentialVersion: BigInt(entry.credentialVersion),
    })
  );

  return createMerkleRoot(leaves);
}

const registryAbi = [
  'function registerBatch(uint256 batchId, bytes32 root, string metadata) external',
  'function batchRoots(uint256 batchId) view returns (bytes32)',
];

export type BatchSubmission = {
  batchId: string;
  root: string;
  entries: QueueEntry[];
  claimed: QueueItem[];
  transaction: TransactionRecord;
};

export class BatchSubmissionCoordinator {
  public readonly queue: BatchQueue;
  public readonly transactions: TransactionTracker;

  constructor(queue = new BatchQueue(), transactions = new TransactionTracker()) {
    this.queue = queue;
    this.transactions = transactions;
  }

  enqueueCredential(entry: Omit<QueueItem, 'status' | 'createdAt' | 'updatedAt'>): QueueItem {
    return this.queue.enqueue(entry);
  }

  claimBatch(workerId: string, maxEntries = 50): BatchSubmission | null {
    const claimed: QueueItem[] = [];
    const entries: QueueEntry[] = [];

    while (claimed.length < maxEntries) {
      const item = this.queue.claimNext(workerId);
      if (!item) {
        break;
      }

      claimed.push(item);
      entries.push({
        credentialId: item.credentialId,
        issuerId: item.issuerId,
        documentDigest: item.documentDigest,
        credentialVersion: item.credentialVersion,
      });
    }

    if (claimed.length === 0) {
      return null;
    }

    const batchId = `batch_${Date.now().toString(16)}`;
    const root = createBatchRoot(entries);
    const transaction = this.transactions.begin(batchId);

    return { batchId, root, entries: assembleBatchEntries(entries), claimed, transaction };
  }

  submitBatch(batchId: string, transactionHash: string): { batchId: string; transaction: TransactionRecord | null } {
    return {
      batchId,
      transaction: this.transactions.submit(batchId, transactionHash),
    };
  }

  confirmBatch(batchId: string): { batchId: string; transaction: TransactionRecord | null } {
    return {
      batchId,
      transaction: this.transactions.confirm(batchId),
    };
  }

  failBatch(batchId: string, reason: string): { batchId: string; transaction: TransactionRecord | null } {
    return {
      batchId,
      transaction: this.transactions.fail(batchId, reason),
    };
  }
}

export class AnchoringWorker {
  private readonly provider: JsonRpcProvider;
  private readonly signer: Wallet;
  private readonly contractAddress: string;
  private readonly contractInterface: Interface;

  constructor({ rpcUrl, signerPrivateKey, contractAddress }: { rpcUrl: string; signerPrivateKey: string; contractAddress: string }) {
    this.provider = new JsonRpcProvider(rpcUrl);
    this.signer = new Wallet(signerPrivateKey, this.provider);
    this.contractAddress = contractAddress;
    this.contractInterface = new Interface(registryAbi);
  }

  get runner(): ContractRunner {
    return this.signer;
  }

  public buildBatch(entries: QueueEntry[]) {
    return {
      entries: assembleBatchEntries(entries),
      root: createBatchRoot(entries),
      batchId: `batch_${Date.now().toString(16)}`,
    };
  }

  public async registerBatch(batchId: number | bigint, root: string, metadata = 'verified-document-vault-batch') {
    const contract = new (await import('ethers')).Contract(this.contractAddress, this.contractInterface, this.runner);
    const tx = await contract.registerBatch(batchId, root, metadata);
    return await tx.wait();
  }
}
