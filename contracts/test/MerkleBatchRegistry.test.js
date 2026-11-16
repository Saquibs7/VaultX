const { expect } = require('chai');
const { ethers } = require('hardhat');

const LEAF_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes('verified-document-vault/credential-leaf/v1'));

function hashPair(left, right) {
  const [a, b] = left.toLowerCase() <= right.toLowerCase() ? [left.toLowerCase(), right.toLowerCase()] : [right.toLowerCase(), left.toLowerCase()];
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [a, b]));
}

function createLeaf({ credentialIdHash, documentDigest, issuerIdHash, credentialVersion }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint256'],
      [LEAF_DOMAIN, credentialIdHash, documentDigest, issuerIdHash, BigInt(credentialVersion)]
    )
  );
}

function createMerkleRoot(leaves) {
  if (leaves.length === 0) return ethers.ZeroHash;

  let current = [...leaves];
  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : current[i];
      next.push(hashPair(left, right));
    }
    current = next;
  }

  return current[0];
}

function createMerkleProof(leaves, targetIndex) {
  if (leaves.length === 0) return [];
  if (targetIndex < 0 || targetIndex >= leaves.length) throw new Error('Index out of range');

  const proof = [];
  let layer = [...leaves];
  let idx = targetIndex;

  while (layer.length > 1) {
    const siblingIndex = idx % 2 === 0 ? idx + 1 : idx - 1;
    const sibling = siblingIndex < layer.length ? layer[siblingIndex] : layer[idx];
    proof.push(sibling);

    const next = [];
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

function verifyMerkleProof({ leaf, proof, root }) {
  let current = leaf;
  for (const sibling of proof) {
    current = hashPair(current, sibling);
  }
  return current === root;
}

describe('MerkleBatchRegistry', function () {
  it('registers a batch root and verifies a valid proof', async function () {
    const [owner, other] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory('MerkleBatchRegistry', owner)).deploy();

    const leaves = [
      createLeaf({ credentialIdHash: ethers.keccak256(ethers.toUtf8Bytes('cred-1')), documentDigest: ethers.keccak256(ethers.toUtf8Bytes('doc-1')), issuerIdHash: ethers.keccak256(ethers.toUtf8Bytes('issuer-1')), credentialVersion: 1 }),
      createLeaf({ credentialIdHash: ethers.keccak256(ethers.toUtf8Bytes('cred-2')), documentDigest: ethers.keccak256(ethers.toUtf8Bytes('doc-2')), issuerIdHash: ethers.keccak256(ethers.toUtf8Bytes('issuer-1')), credentialVersion: 1 }),
      createLeaf({ credentialIdHash: ethers.keccak256(ethers.toUtf8Bytes('cred-3')), documentDigest: ethers.keccak256(ethers.toUtf8Bytes('doc-3')), issuerIdHash: ethers.keccak256(ethers.toUtf8Bytes('issuer-1')), credentialVersion: 1 }),
    ];

    const root = createMerkleRoot(leaves);
    const proof = createMerkleProof(leaves, 1);

    await expect(registry.registerBatch(1, root, 'northbridge-2026')).to.emit(registry, 'BatchRegistered');
    expect(await registry.batchRoots(1)).to.equal(root);
    expect(verifyMerkleProof({ leaf: leaves[1], proof, root })).to.equal(true);

    await expect(registry.connect(other).registerBatch(2, root, 'bad')).to.be.revertedWith('not-authorized');
  });

  it('rejects duplicate batch IDs and unauthorized revocations', async function () {
    const [owner, attacker] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory('MerkleBatchRegistry', owner)).deploy();
    const root = ethers.keccak256(ethers.toUtf8Bytes('batch-root'));

    await registry.registerBatch(42, root, 'first');
    await expect(registry.registerBatch(42, root, 'duplicate')).to.be.revertedWith('duplicate-batch-id');
    await expect(registry.connect(attacker).revokeCredential(ethers.keccak256(ethers.toUtf8Bytes('revoked-credential')))).to.be.revertedWith('not-authorized');
  });
});
