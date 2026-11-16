import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';

export const LEAF_DOMAIN = keccak256(toUtf8Bytes('verified-document-vault/credential-leaf/v1'));
export const EMPTY_ROOT = '0x' + '00'.repeat(32);

const coder = AbiCoder.defaultAbiCoder();

export function normalizeBytes32(value: string): string {
  const normalized = value.startsWith('0x') ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`Invalid bytes32 value: ${value}`);
  }
  return normalized.toLowerCase();
}

export function hashStringId(value: string): string {
  return keccak256(toUtf8Bytes(value)).toLowerCase();
}

export function createLeaf({
  credentialIdHash,
  documentDigest,
  issuerIdHash,
  credentialVersion,
}: {
  credentialIdHash: string;
  documentDigest: string;
  issuerIdHash: string;
  credentialVersion: number | bigint;
}): string {
  return keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint256'],
      [LEAF_DOMAIN, normalizeBytes32(credentialIdHash), normalizeBytes32(documentDigest), normalizeBytes32(issuerIdHash), BigInt(credentialVersion)]
    )
  ).toLowerCase();
}

export function hashPair(left: string, right: string): string {
  const [a, b] = left.toLowerCase() <= right.toLowerCase() ? [left.toLowerCase(), right.toLowerCase()] : [right.toLowerCase(), left.toLowerCase()];
  return keccak256(coder.encode(['bytes32', 'bytes32'], [a, b])).toLowerCase();
}

export function createMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) {
    return EMPTY_ROOT;
  }

  let current = leaves.map((leaf) => normalizeBytes32(leaf));

  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : current[i];
      next.push(hashPair(left, right));
    }
    current = next;
  }

  return current[0];
}

export function createMerkleProof(leaves: string[], targetIndex: number): string[] {
  if (leaves.length === 0) {
    return [];
  }

  if (targetIndex < 0 || targetIndex >= leaves.length) {
    throw new Error('Target index out of range');
  }

  const normalized = leaves.map((leaf) => normalizeBytes32(leaf));
  const proof: string[] = [];
  let layer = [...normalized];
  let idx = targetIndex;

  while (layer.length > 1) {
    const pairIndex = idx % 2 === 0 ? idx + 1 : idx - 1;
    const sibling = pairIndex < layer.length ? layer[pairIndex] : layer[idx];
    proof.push(sibling);

    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(hashPair(left, right));
    }

    layer = next;
    idx = Math.floor(idx / 2);
  }

  return proof;
}

export function verifyMerkleProof({
  leaf,
  proof,
  root,
}: {
  leaf: string;
  proof: string[];
  root: string;
}): boolean {
  let current = normalizeBytes32(leaf);
  const expectedRoot = normalizeBytes32(root);

  for (const sibling of proof) {
    const candidate = hashPair(current, normalizeBytes32(sibling));
    current = candidate;
  }

  return current === expectedRoot;
}
