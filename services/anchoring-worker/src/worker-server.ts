import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Contract, JsonRpcProvider, Wallet, ZeroHash } from 'ethers';
import { createLeaf, createMerkleProof, createMerkleRoot, hashStringId, normalizeBytes32 } from '@verified-document-vault/crypto-protocol';

import { assembleBatchEntries, type QueueEntry } from './index.js';

type ClaimedCredential = QueueEntry & { credentialId: string };
type ClaimResponse = { items: ClaimedCredential[] };
type RevocationClaimResponse = { items: Array<{ credentialId: string }> };
type AnchorReceipt = {
  transactionHash: string;
  blockNumber: number;
};

type BatchEvidence = {
  root: string;
  batchId: string;
  proofs: Array<{ credentialId: string; proof: string[] }>;
};

const registryAbi = [
  'function registerBatch(uint256 batchId, bytes32 root, string metadata) external',
  'function batchRoots(uint256 batchId) view returns (bytes32)',
  'function revokeCredential(bytes32 credentialIdHash) external',
  'function isCredentialRevoked(bytes32 credentialIdHash) view returns (bool)',
  'event BatchRegistered(uint256 indexed batchId, bytes32 indexed root, string metadata)',
  'event CredentialRevoked(bytes32 indexed credentialIdHash, address indexed revoker)',
];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the anchoring worker`);
  return value;
}

const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
const apiKey = required('WORKER_API_KEY');
const rpcUrl = required('RPC_URL');
const privateKey = required('PRIVATE_KEY');
const workerId = process.env.WORKER_ID ?? `${os.hostname()}-${process.pid}`;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 2_000);
const batchLimit = Math.min(Math.max(Number(process.env.BATCH_LIMIT ?? 20), 1), 50);

let provider: JsonRpcProvider;
let registry: Contract;

async function resolveContractAddress(): Promise<string> {
  if (process.env.CONTRACT_ADDRESS) return process.env.CONTRACT_ADDRESS;
  const deploymentFile = process.env.DEPLOYMENT_FILE ?? '/deployments/registry.json';
  const deployment = JSON.parse(await fs.readFile(path.resolve(deploymentFile), 'utf8')) as { address?: string; chainId?: string };
  if (!deployment.address || !/^0x[0-9a-fA-F]{40}$/.test(deployment.address)) {
    throw new Error(`Deployment manifest ${deploymentFile} does not contain a valid registry address`);
  }
  if (deployment.chainId && BigInt(deployment.chainId) !== 31337n) {
    throw new Error(`Refusing unexpected local registry chain ID ${deployment.chainId}`);
  }
  return deployment.address;
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-worker-api-key', apiKey);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(new URL(path, apiUrl), { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`API worker request failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

async function findExistingReceipt(batchId: bigint, expectedRoot: string): Promise<AnchorReceipt | null> {
  const existingRoot = String(await registry.batchRoots(batchId));
  if (existingRoot.toLowerCase() === ZeroHash) return null;
  if (existingRoot.toLowerCase() !== expectedRoot.toLowerCase()) {
    throw new Error(`batch id collision for ${batchId.toString()}`);
  }

  const logs = await registry.queryFilter(registry.filters.BatchRegistered(batchId));
  const match = [...logs].reverse().find((log) => {
    const parsed = 'args' in log ? log.args : undefined;
    return parsed?.root?.toLowerCase() === expectedRoot.toLowerCase();
  });
  if (!match) throw new Error(`registered batch ${batchId.toString()} has no discoverable receipt`);
  return { transactionHash: match.transactionHash, blockNumber: match.blockNumber };
}

function createBatchEvidence(items: ClaimedCredential[]): BatchEvidence {
  const entries = assembleBatchEntries(items.map((item) => ({
    credentialId: item.credentialId,
    issuerId: item.issuerId,
    documentDigest: item.documentDigest,
    credentialVersion: item.credentialVersion,
  } satisfies QueueEntry)));
  const leaves = entries.map((entry) => createLeaf({
    credentialIdHash: hashStringId(entry.credentialId),
    documentDigest: normalizeBytes32(entry.documentDigest.startsWith('0x') ? entry.documentDigest : `0x${entry.documentDigest}`),
    issuerIdHash: hashStringId(entry.issuerId),
    credentialVersion: BigInt(entry.credentialVersion),
  }));
  const root = createMerkleRoot(leaves);
  return {
    root,
    batchId: BigInt(root).toString(),
    proofs: entries.map((entry, index) => ({
      credentialId: entry.credentialId,
      proof: createMerkleProof(leaves, index),
    })),
  };
}

async function anchorClaimedBatch(items: ClaimedCredential[], root: string, batchId: bigint): Promise<AnchorReceipt> {
  const existingReceipt = await findExistingReceipt(batchId, root);
  if (existingReceipt) return existingReceipt;

  const metadata = JSON.stringify({
    schemaVersion: 1,
    credentialCount: items.length,
    workerId,
  });
  const transaction = await registry.registerBatch(batchId, root, metadata);
  const receipt = await transaction.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error('batch registration transaction was not confirmed');
  return { transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
}

export async function runWorkerOnce(): Promise<number> {
  const claimed = await apiRequest<ClaimResponse>(
    `/api/v1/internal/anchoring/claim?workerId=${encodeURIComponent(workerId)}&limit=${batchLimit}`,
  );
  if (claimed.items.length === 0) return 0;

  const evidence = createBatchEvidence(claimed.items);
  try {
    const receipt = await anchorClaimedBatch(claimed.items, evidence.root, BigInt(evidence.batchId));
    await apiRequest('/api/v1/internal/anchoring/complete', {
      method: 'POST',
      body: JSON.stringify({
        workerId,
        credentialIds: claimed.items.map((item) => item.credentialId),
        batchId: evidence.batchId,
        root: evidence.root,
        proofs: evidence.proofs,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
      }),
    });
    console.info(`Anchored ${claimed.items.length} credentials in batch ${evidence.root.slice(0, 14)}…`);
    return claimed.items.length;
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 480) : 'unknown_anchor_error';
    try {
      await apiRequest('/api/v1/internal/anchoring/release', {
        method: 'POST',
        body: JSON.stringify({
          workerId,
          credentialIds: claimed.items.map((item) => item.credentialId),
          reason,
        }),
      });
    } catch (releaseError) {
      console.error('Unable to release failed claims; the API lease will expire:', releaseError);
    }
    console.error('Batch anchoring failed:', error);
    return 0;
  }
}

export async function runRevocationOnce(): Promise<number> {
  const claimed = await apiRequest<RevocationClaimResponse>(
    `/api/v1/internal/revocations/claim?workerId=${encodeURIComponent(workerId)}`,
  );
  if (claimed.items.length === 0) return 0;
  let completed = 0;

  for (const item of claimed.items) {
    try {
      const credentialIdHash = hashStringId(item.credentialId);
      let transactionHash = '';
      let blockNumber = 0;
      const alreadyRevoked = Boolean(await registry.isCredentialRevoked(credentialIdHash));
      if (alreadyRevoked) {
        const logs = await registry.queryFilter(registry.filters.CredentialRevoked(credentialIdHash));
        const match = [...logs].reverse()[0];
        if (!match) throw new Error('revocation exists but its receipt event could not be found');
        transactionHash = match.transactionHash;
        blockNumber = match.blockNumber;
      } else {
        const transaction = await registry.revokeCredential(credentialIdHash);
        const receipt = await transaction.wait(1);
        if (!receipt || receipt.status !== 1) throw new Error('revocation transaction was not confirmed');
        transactionHash = receipt.hash;
        blockNumber = receipt.blockNumber;
      }
      await apiRequest('/api/v1/internal/revocations/complete', {
        method: 'POST',
        body: JSON.stringify({
          workerId,
          credentialIds: [item.credentialId],
          transactionHash,
          blockNumber,
        }),
      });
      completed += 1;
      console.info(`Revoked credential ${item.credentialId} on-chain`);
    } catch (error) {
      try {
        await apiRequest('/api/v1/internal/revocations/release', {
          method: 'POST',
          body: JSON.stringify({ workerId, credentialIds: [item.credentialId] }),
        });
      } catch (releaseError) {
        console.error('Unable to release revocation claim; API lease will expire:', releaseError);
      }
      console.error(`On-chain revocation failed for ${item.credentialId}:`, error);
    }
  }
  return completed;
}

async function main() {
  provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(privateKey, provider);
  registry = new Contract(await resolveContractAddress(), registryAbi, signer);
  const network = await provider.getNetwork();
  if (network.chainId !== 31337n) throw new Error(`Refusing to anchor on unexpected chain ${network.chainId.toString()}`);
  console.info(`Anchoring worker ${workerId} connected to chain ${network.chainId.toString()}`);
  while (true) {
    try {
      await runWorkerOnce();
      await runRevocationOnce();
    } catch (error) {
      console.error('Anchoring poll failed:', error);
    }
    await delay(pollIntervalMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
