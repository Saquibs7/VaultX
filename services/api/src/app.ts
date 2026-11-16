import express, { type Request, type Response, NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { Contract, JsonRpcProvider } from 'ethers';
import { z } from 'zod';

import { createLeaf, hashStringId, normalizeBytes32, verifyMerkleProof } from '@verified-document-vault/crypto-protocol';
import { config } from './config.js';
import { createIssuerKeyPair, decryptDocument, encryptDocument, hashPassword, signToken, verifyPassword, verifyToken } from './auth.js';
import { createPersistenceStore, type PersistenceStore } from './persistence.js';
import type { Credential, Institution, Issuer } from './types.js';

function detectFileMime(buffer: Buffer): string | null {
  if (buffer.length >= 4 && buffer.slice(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) {
    return 'application/pdf';
  }

  if (buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }

  if (buffer.length >= 2 && buffer[0] === 0x7b && buffer[1] === 0x22) {
    return 'application/json';
  }

  if (buffer.length >= 5 && /[\u0000-\u007F]+/.test(buffer.toString('utf8')) && !buffer.includes(0x00)) {
    return 'text/plain';
  }

  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSizeBytes },
});

const institutions: Institution[] = [];
const issuers: Issuer[] = [];
const credentials: Credential[] = [];
const encryptedDocuments = new Map<string, { ciphertext: string; nonce: string; keyId: string }>();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const institutionSchema = z.object({
  name: z.string().min(2),
});

const issuerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email().optional(),
  password: z.string().min(12).optional(),
  role: z.enum(['ISSUER']).default('ISSUER'),
});

const credentialBodySchema = z.object({
  holderReference: z.string().min(1),
  credentialVersion: z.coerce.number().int().positive(),
  issuerId: z.string().min(1),
});

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function createCanonicalPayload(credential: Pick<Credential, 'id' | 'issuerId' | 'holderReference' | 'credentialVersion' | 'documentDigest' | 'issuedAt' | 'issuerKeyId' | 'schemaVersion'>) {
  return JSON.stringify({
    credentialId: credential.id,
    issuerId: credential.issuerId,
    holderReference: credential.holderReference,
    credentialVersion: credential.credentialVersion,
    documentDigest: credential.documentDigest,
    issuerKeyId: credential.issuerKeyId,
    schemaVersion: credential.schemaVersion,
    issuedAt: credential.issuedAt,
  });
}

function createCredentialResponse(credential: Credential) {
  return {
    id: credential.id,
    issuerId: credential.issuerId,
    institutionId: credential.institutionId,
    holderReference: credential.holderReference,
    documentDigest: credential.documentDigest,
    documentStorageReference: credential.documentStorageReference,
    documentEncryptionMetadata: credential.documentEncryptionMetadata,
    issuerKeyId: credential.issuerKeyId,
    schemaVersion: credential.schemaVersion,
    credentialVersion: credential.credentialVersion,
    issuedAt: credential.issuedAt,
    deadlineAt: credential.deadlineAt,
    lifecycleStatus: credential.lifecycleStatus,
    anchorState: credential.anchorState ?? 'QUEUED',
    anchorBatchId: credential.anchorBatchId,
    anchorRoot: credential.anchorRoot,
    anchorTransactionHash: credential.anchorTransactionHash,
    anchorBlockNumber: credential.anchorBlockNumber,
    revocationState: credential.revocationState,
    revocationTransactionHash: credential.revocationTransactionHash,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}

function requireIssuerAccess(req: Request, res: Response, credential: Credential) {
  const user = (req as Request & { user?: { id: string; institutionId: string; role: string } }).user;
  const issuer = issuers.find((entry) => entry.id === user?.id);
  if (!issuer) {
    return { authorized: false, reason: 'issuer_not_found' } as const;
  }

  if (issuer.institutionId !== credential.institutionId && issuer.role !== 'ADMIN') {
    return { authorized: false, reason: 'forbidden' } as const;
  }

  return { authorized: true, issuer } as const;
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token) {
    res.status(401).json({ error: 'missing_auth_token' });
    return;
  }

  try {
    const payload = verifyToken(token);
    (req as Request & { user?: { id: string; institutionId: string; role: string } }).user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'invalid_auth_token' });
  }
}

function demoBootstrapOnly(_req: Request, res: Response, next: NextFunction) {
  if (!config.allowDemoBootstrap) {
    res.status(403).json({ error: 'demo_bootstrap_disabled' });
    return;
  }
  next();
}

const revokedCredentialStatus = 'REVOKED_CREDENTIAL';

function workerAuth(req: Request, res: Response, next: NextFunction) {
  const provided = req.headers['x-worker-api-key'];
  const expected = config.workerApiKey;
  if (!expected || typeof provided !== 'string') {
    res.status(401).json({ error: 'invalid_worker_credentials' });
    return;
  }
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    res.status(401).json({ error: 'invalid_worker_credentials' });
    return;
  }
  next();
}

export async function createApp() {
  const persistence: PersistenceStore = await createPersistenceStore(config.mongoUri);
  const persistedState = await persistence.load();
  institutions.splice(0, institutions.length, ...persistedState.institutions);
  issuers.splice(0, issuers.length, ...persistedState.issuers);
  credentials.splice(0, credentials.length, ...persistedState.credentials);
  encryptedDocuments.clear();
  for (const item of persistedState.encryptedDocuments) {
    encryptedDocuments.set(item.credentialId, item.value);
  }

  let registryAddress = config.registryAddress;
  if (!registryAddress && config.registryDeploymentFile) {
    const deployment = JSON.parse(await fs.readFile(config.registryDeploymentFile, 'utf8')) as { address?: string; chainId?: string };
    if (!deployment.address || !/^0x[0-9a-fA-F]{40}$/.test(deployment.address)) {
      throw new Error('Registry deployment file does not contain a valid contract address');
    }
    if (deployment.chainId && BigInt(deployment.chainId) !== config.chainId) {
      throw new Error(`Registry deployment chain ${deployment.chainId} does not match configured chain ${config.chainId.toString()}`);
    }
    registryAddress = deployment.address;
  }
  const provider = registryAddress ? new JsonRpcProvider(config.rpcUrl) : null;
  const registryAbi = [
    'function batchRoots(uint256 batchId) view returns (bytes32)',
    'function isCredentialRevoked(bytes32 credentialIdHash) view returns (bool)',
  ];
  const registry = registryAddress && provider ? new Contract(registryAddress, registryAbi, provider) : null;
  if (provider) {
    const network = await provider.getNetwork();
    if (network.chainId !== config.chainId) {
      throw new Error(`Connected chain ${network.chainId.toString()} does not match configured chain ${config.chainId.toString()}`);
    }
  }

  async function checkOnChainEvidence(credential: Credential) {
    if (credential.anchorState !== 'ANCHORED') {
      return { status: credential.anchorState === 'CLAIMED' ? 'ANCHORING' : 'PENDING', revoked: false };
    }
    if (!registry || !credential.anchorBatchId || !credential.anchorRoot || !credential.anchorProof) {
      return { status: 'ANCHOR_UNAVAILABLE', revoked: false };
    }
    try {
      const onChainRoot = String(await registry.batchRoots(BigInt(credential.anchorBatchId)));
      if (onChainRoot.toLowerCase() !== credential.anchorRoot.toLowerCase()) {
        return { status: 'BATCH_ROOT_MISMATCH', revoked: false };
      }
      const leaf = createLeaf({
        credentialIdHash: hashStringId(credential.id),
        documentDigest: normalizeBytes32(credential.documentDigest),
        issuerIdHash: hashStringId(credential.issuerId),
        credentialVersion: BigInt(credential.credentialVersion),
      });
      if (!verifyMerkleProof({ leaf, proof: credential.anchorProof, root: onChainRoot })) {
        return { status: 'INVALID_MERKLE_PROOF', revoked: false };
      }
      const revoked = Boolean(await registry.isCredentialRevoked(hashStringId(credential.id)));
      return { status: 'CONFIRMED', revoked };
    } catch (error) {
      console.error('On-chain credential check failed:', error);
      return { status: 'ANCHOR_UNAVAILABLE', revoked: false };
    }
  }

  const app = express();
  app.locals.persistence = persistence;

  app.use(cors({ origin: config.frontendOrigin, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'verified-document-vault-api',
      storage: persistence.storageMode,
      persistence: persistence.storageMode === 'mongodb' ? 'durable' : 'volatile',
      demoBootstrapEnabled: config.allowDemoBootstrap,
      blockchain: registry ? 'connected' : 'unconfigured',
      chainId: registry ? config.chainId.toString() : null,
    });
  });

  app.post('/api/v1/auth/login', (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_login_payload', details: parsed.error.flatten() });
      return;
    }

    const issuer = issuers.find((entry) => entry.email === parsed.data.email);
    if (!issuer || !verifyPassword(parsed.data.password, issuer.passwordHash)) {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }

    const token = signToken({ id: issuer.id, institutionId: issuer.institutionId, role: issuer.role });
    res.json({
      token,
      user: {
        id: issuer.id,
        institutionId: issuer.institutionId,
        name: issuer.name,
        email: issuer.email,
        role: issuer.role,
      },
    });
  });

  app.get('/api/v1/auth/me', authMiddleware, (req, res) => {
    const user = (req as Request & { user?: { id: string; institutionId: string; role: string } }).user;
    const issuer = issuers.find((entry) => entry.id === user?.id);
    if (!issuer) {
      res.status(404).json({ error: 'user_not_found' });
      return;
    }

    res.json({
      id: issuer.id,
      institutionId: issuer.institutionId,
      name: issuer.name,
      email: issuer.email,
      role: issuer.role,
    });
  });

  app.post('/api/v1/institutions', demoBootstrapOnly, async (req, res) => {
    const parsed = institutionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_institution_payload', details: parsed.error.flatten() });
      return;
    }

    const institution: Institution = {
      id: generateId('inst'),
      name: parsed.data.name,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
    };

    institutions.push(institution);
    await persistence.saveInstitution(institution);
    res.status(201).json(institution);
  });

  app.get('/api/v1/institutions/:id', (req, res) => {
    const institution = institutions.find((entry) => entry.id === req.params.id);
    if (!institution) {
      res.status(404).json({ error: 'institution_not_found' });
      return;
    }
    res.json(institution);
  });

  app.post('/api/v1/institutions/:id/issuers', demoBootstrapOnly, async (req, res) => {
    const institution = institutions.find((entry) => entry.id === req.params.id);
    if (!institution) {
      res.status(404).json({ error: 'institution_not_found' });
      return;
    }

    const parsed = issuerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_issuer_payload', details: parsed.error.flatten() });
      return;
    }

    const normalizedName = parsed.data.name.trim();
    const email = parsed.data.email ?? `${normalizedName.toLowerCase().replace(/\s+/g, '.')}@${institution.name.toLowerCase().replace(/\s+/g, '.')}.edu`;
    const defaultPassword = parsed.data.password ?? config.demoIssuerPassword;
    const keyPair = createIssuerKeyPair();
    const issuer: Issuer = {
      id: generateId('iss'),
      institutionId: institution.id,
      name: normalizedName,
      email,
      passwordHash: hashPassword(defaultPassword),
      role: parsed.data.role,
      publicKeyPem: keyPair.publicKeyPem,
      privateKeyPem: keyPair.privateKeyPem,
      keyId: keyPair.keyId,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
    };

    issuers.push(issuer);
    await persistence.saveIssuer(issuer);
    res.status(201).json({
      id: issuer.id,
      institutionId: issuer.institutionId,
      name: issuer.name,
      email: issuer.email,
      role: issuer.role,
      keyId: issuer.keyId,
      createdAt: issuer.createdAt,
      status: issuer.status,
    });
  });

  app.post('/api/v1/credentials', authMiddleware, upload.single('credentialFile'), async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'missing_file' });
      return;
    }

    const parsed = credentialBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_credential_payload', details: parsed.error.flatten() });
      return;
    }

    const detectedMime = detectFileMime(file.buffer);
    const allowed = new Set(config.allowedMimeTypes);
    if (detectedMime === null || !allowed.has(detectedMime)) {
      res.status(400).json({ error: 'unsupported_file_type' });
      return;
    }

    const user = (req as Request & { user?: { id: string; institutionId: string; role: string } }).user;
    const issuer = issuers.find((entry) => entry.id === user?.id);
    if (!issuer) {
      res.status(404).json({ error: 'issuer_not_found' });
      return;
    }

    if (issuer.id !== parsed.data.issuerId) {
      res.status(403).json({ error: 'issuer_mismatch' });
      return;
    }

    if (issuer.status !== 'ACTIVE') {
      res.status(403).json({ error: 'issuer_suspended' });
      return;
    }

    const documentBuffer = file.buffer;
    const documentDigest = crypto.createHash('sha256').update(documentBuffer).digest('hex');
    const encrypted = encryptDocument(documentBuffer);

    const credentialId = generateId('cred');
    const now = new Date().toISOString();
    const credential: Credential = {
      id: credentialId,
      issuerId: issuer.id,
      institutionId: issuer.institutionId,
      holderReference: parsed.data.holderReference,
      documentDigest,
      documentStorageReference: `storage://${credentialId}`,
      documentEncryptionMetadata: {
        algorithm: 'AES-256-GCM',
        keyId: encrypted.keyId,
        nonce: encrypted.nonce,
      },
      issuerSignature: '',
      issuerKeyId: issuer.keyId,
      schemaVersion: 1,
      credentialVersion: parsed.data.credentialVersion,
      issuedAt: now,
      deadlineAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
      lifecycleStatus: 'PENDING_ANCHOR',
      anchorState: 'QUEUED',
      createdAt: now,
      updatedAt: now,
    };

    const payload = createCanonicalPayload({
      id: credential.id,
      issuerId: credential.issuerId,
      holderReference: credential.holderReference,
      credentialVersion: credential.credentialVersion,
      documentDigest: credential.documentDigest,
      issuedAt: credential.issuedAt,
      issuerKeyId: credential.issuerKeyId,
      schemaVersion: credential.schemaVersion,
    });

    const privateKey = crypto.createPrivateKey(issuer.privateKeyPem);
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
    credential.issuerSignature = signature;
    credentials.push(credential);
    await persistence.saveCredential(credential);

    const encryptedDocument = {
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      keyId: encrypted.keyId,
    };
    encryptedDocuments.set(credential.id, encryptedDocument);
    await persistence.saveEncryptedDocument(credential.id, encryptedDocument);

    res.status(201).json(createCredentialResponse(credential));
  });

  app.get('/api/v1/credentials', authMiddleware, (req, res) => {
    const user = (req as Request & { user?: { id: string; institutionId: string; role: string } }).user;
    const issuer = issuers.find((entry) => entry.id === user?.id);
    if (!issuer) {
      res.status(404).json({ error: 'issuer_not_found' });
      return;
    }
    const visibleCredentials = issuer.role === 'ADMIN'
      ? credentials
      : credentials.filter((entry) => entry.institutionId === issuer.institutionId);
    res.json({ items: visibleCredentials.map(createCredentialResponse) });
  });

  app.get('/api/v1/credentials/:id', authMiddleware, (req, res) => {
    const credential = credentials.find((entry) => entry.id === req.params.id);
    if (!credential) {
      res.status(404).json({ error: 'credential_not_found' });
      return;
    }

    const access = requireIssuerAccess(req, res, credential);
    if (!access.authorized) {
      res.status(403).json({ error: access.reason });
      return;
    }

    res.json(createCredentialResponse(credential));
  });

  app.get('/api/v1/credentials/:id/document', authMiddleware, (req, res) => {
    const credential = credentials.find((entry) => entry.id === req.params.id);
    if (!credential) {
      res.status(404).json({ error: 'credential_not_found' });
      return;
    }

    const access = requireIssuerAccess(req, res, credential);
    if (!access.authorized) {
      res.status(403).json({ error: access.reason });
      return;
    }

    const record = encryptedDocuments.get(credential.id);
    if (!record) {
      res.status(404).json({ error: 'document_not_found' });
      return;
    }

    const document = decryptDocument(record.ciphertext, record.nonce);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="credential-${credential.id}.bin"`);
    res.send(document);
  });

  app.post('/api/v1/credentials/:id/revoke', authMiddleware, async (req, res) => {
    const credential = credentials.find((entry) => entry.id === req.params.id);
    if (!credential) {
      res.status(404).json({ error: 'credential_not_found' });
      return;
    }

    const access = requireIssuerAccess(req, res, credential);
    if (!access.authorized) {
      res.status(403).json({ error: access.reason });
      return;
    }

    credential.lifecycleStatus = 'REVOKED';
    if (credential.anchorState === 'ANCHORED') {
      credential.revocationState = 'QUEUED';
    } else {
      credential.anchorState = 'FAILED';
      credential.revocationState = 'NOT_REQUIRED';
      credential.anchorClaimedAt = undefined;
      credential.anchorWorkerId = undefined;
      credential.lastAnchorError = 'revoked_before_anchor';
    }
    credential.updatedAt = new Date().toISOString();
    await persistence.saveCredential(credential);
    res.json({
      status: credential.revocationState === 'QUEUED' ? 'REVOCATION_PENDING' : 'REVOKED',
      credentialId: credential.id,
      lifecycleStatus: credential.lifecycleStatus,
      revocationState: credential.revocationState,
    });
  });

  app.get('/api/v1/internal/anchoring/claim', workerAuth, async (req, res) => {
    const workerId = String(req.query.workerId ?? '').trim();
    if (!workerId) {
      res.status(400).json({ error: 'worker_id_required' });
      return;
    }
    const parsedLimit = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(Math.floor(parsedLimit), 1), 50) : 20;
    const retryBefore = Date.now() - 60_000;
    const claimed = credentials
      .filter((credential) => credential.lifecycleStatus === 'PENDING_ANCHOR' && (
        credential.anchorState === 'QUEUED'
        || (credential.anchorState === 'CLAIMED' && Date.parse(credential.anchorClaimedAt ?? '') < retryBefore)
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit);

    for (const credential of claimed) {
      credential.anchorState = 'CLAIMED';
      credential.anchorClaimedAt = new Date().toISOString();
      credential.anchorWorkerId = workerId;
      credential.updatedAt = new Date().toISOString();
      await persistence.saveCredential(credential);
    }
    res.json({ items: claimed.map((credential) => ({
      credentialId: credential.id,
      issuerId: credential.issuerId,
      documentDigest: credential.documentDigest,
      credentialVersion: credential.credentialVersion,
    })) });
  });

  app.post('/api/v1/internal/anchoring/complete', workerAuth, async (req, res) => {
    const schema = z.object({
      workerId: z.string().min(1),
      credentialIds: z.array(z.string().min(1)).min(1).max(50),
      batchId: z.string().min(1),
      root: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      proofs: z.array(z.object({
        credentialId: z.string().min(1),
        proof: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)),
      })).min(1).max(50),
      transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      blockNumber: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_anchor_receipt', details: parsed.error.flatten() });
      return;
    }
    const claimed = parsed.data.credentialIds.map((id) => credentials.find((credential) => credential.id === id));
    const proofMap = new Map(parsed.data.proofs.map((entry) => [entry.credentialId, entry.proof]));
    if (claimed.some((credential) => !credential || credential.lifecycleStatus !== 'PENDING_ANCHOR' || credential.anchorState !== 'CLAIMED' || credential.anchorWorkerId !== parsed.data.workerId || !proofMap.has(credential.id))) {
      res.status(409).json({ error: 'anchor_claim_mismatch' });
      return;
    }
    for (const credential of claimed as Credential[]) {
      credential.lifecycleStatus = 'ANCHORED';
      credential.anchorState = 'ANCHORED';
      credential.anchorBatchId = parsed.data.batchId;
      credential.anchorRoot = parsed.data.root.toLowerCase();
      credential.anchorProof = proofMap.get(credential.id);
      credential.anchorTransactionHash = parsed.data.transactionHash.toLowerCase();
      credential.anchorBlockNumber = String(parsed.data.blockNumber);
      credential.anchorClaimedAt = undefined;
      credential.anchorWorkerId = undefined;
      credential.updatedAt = new Date().toISOString();
      await persistence.saveCredential(credential);
    }
    res.json({ status: 'ANCHORED', credentialIds: parsed.data.credentialIds, batchId: parsed.data.batchId });
  });

  app.get('/api/v1/internal/revocations/claim', workerAuth, async (req, res) => {
    const workerId = String(req.query.workerId ?? '').trim();
    if (!workerId) {
      res.status(400).json({ error: 'worker_id_required' });
      return;
    }
    const retryBefore = Date.now() - 60_000;
    const claimed = credentials
      .filter((credential) => credential.lifecycleStatus === 'REVOKED' && credential.anchorState === 'ANCHORED' && (
        credential.revocationState === 'QUEUED'
        || (credential.revocationState === 'CLAIMED' && Date.parse(credential.revocationClaimedAt ?? '') < retryBefore)
      ))
      .slice(0, 50);
    for (const credential of claimed) {
      credential.revocationState = 'CLAIMED';
      credential.revocationClaimedAt = new Date().toISOString();
      credential.revocationWorkerId = workerId;
      await persistence.saveCredential(credential);
    }
    res.json({ items: claimed.map((credential) => ({ credentialId: credential.id })) });
  });

  app.post('/api/v1/internal/revocations/complete', workerAuth, async (req, res) => {
    const schema = z.object({
      workerId: z.string().min(1),
      credentialIds: z.array(z.string().min(1)).min(1).max(50),
      transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      blockNumber: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_revocation_receipt', details: parsed.error.flatten() });
      return;
    }
    const claimed = parsed.data.credentialIds.map((id) => credentials.find((credential) => credential.id === id));
    if (claimed.some((credential) => !credential || credential.revocationState !== 'CLAIMED' || credential.revocationWorkerId !== parsed.data.workerId)) {
      res.status(409).json({ error: 'revocation_claim_mismatch' });
      return;
    }
    for (const credential of claimed as Credential[]) {
      credential.revocationState = 'CONFIRMED';
      credential.revocationTransactionHash = parsed.data.transactionHash.toLowerCase();
      credential.revocationBlockNumber = String(parsed.data.blockNumber);
      credential.revocationClaimedAt = undefined;
      credential.revocationWorkerId = undefined;
      credential.updatedAt = new Date().toISOString();
      await persistence.saveCredential(credential);
    }
    res.json({ status: 'REVOCATION_CONFIRMED', credentialIds: parsed.data.credentialIds });
  });

  app.post('/api/v1/internal/revocations/release', workerAuth, async (req, res) => {
    const schema = z.object({ workerId: z.string().min(1), credentialIds: z.array(z.string().min(1)).min(1).max(50) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_revocation_release', details: parsed.error.flatten() });
      return;
    }
    const claimed = parsed.data.credentialIds.map((id) => credentials.find((credential) => credential.id === id));
    if (claimed.some((credential) => !credential || credential.revocationState !== 'CLAIMED' || credential.revocationWorkerId !== parsed.data.workerId)) {
      res.status(409).json({ error: 'revocation_claim_mismatch' });
      return;
    }
    for (const credential of claimed as Credential[]) {
      credential.revocationState = 'QUEUED';
      credential.revocationClaimedAt = undefined;
      credential.revocationWorkerId = undefined;
      await persistence.saveCredential(credential);
    }
    res.json({ status: 'QUEUED', credentialIds: parsed.data.credentialIds });
  });

  app.post('/api/v1/internal/anchoring/release', workerAuth, async (req, res) => {
    const schema = z.object({
      workerId: z.string().min(1),
      credentialIds: z.array(z.string().min(1)).min(1).max(50),
      reason: z.string().max(500).default('anchor_submission_failed'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_anchor_release', details: parsed.error.flatten() });
      return;
    }
    const claimed = parsed.data.credentialIds.map((id) => credentials.find((credential) => credential.id === id));
    if (claimed.some((credential) => !credential || credential.anchorState !== 'CLAIMED' || credential.anchorWorkerId !== parsed.data.workerId)) {
      res.status(409).json({ error: 'anchor_claim_mismatch' });
      return;
    }
    for (const credential of claimed as Credential[]) {
      credential.anchorState = 'QUEUED';
      credential.lastAnchorError = parsed.data.reason;
      credential.anchorClaimedAt = undefined;
      credential.anchorWorkerId = undefined;
      credential.updatedAt = new Date().toISOString();
      await persistence.saveCredential(credential);
    }
    res.json({ status: 'QUEUED', credentialIds: parsed.data.credentialIds });
  });

  app.post('/api/v1/verify', upload.single('credentialFile'), async (req, res) => {
    const bodySchema = z.object({
      credentialId: z.string().min(1),
      document: z.string().min(1).optional(),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success || (!req.file && !parsed.data.document)) {
      res.status(400).json({
        error: 'invalid_verification_payload',
        details: parsed.success ? undefined : parsed.error.flatten(),
      });
      return;
    }

    const credential = credentials.find((entry) => entry.id === parsed.data.credentialId);
    if (!credential) {
      res.status(404).json({ status: 'UNKNOWN_CREDENTIAL', error: 'credential_not_found' });
      return;
    }

    const documentBuffer = req.file?.buffer ?? Buffer.from(parsed.data.document ?? '', 'utf8');
    const calculatedDigest = crypto.createHash('sha256').update(documentBuffer).digest('hex');
    if (calculatedDigest !== credential.documentDigest) {
      res.json({ status: 'INVALID_DOCUMENT', credentialId: credential.id, expectedDigest: credential.documentDigest, receivedDigest: calculatedDigest });
      return;
    }

    const issuer = issuers.find((entry) => entry.id === credential.issuerId);
    if (!issuer) {
      res.json({ status: 'UNKNOWN_ISSUER', credentialId: credential.id });
      return;
    }

    const payload = createCanonicalPayload({
      id: credential.id,
      issuerId: credential.issuerId,
      holderReference: credential.holderReference,
      credentialVersion: credential.credentialVersion,
      documentDigest: credential.documentDigest,
      issuedAt: credential.issuedAt,
      issuerKeyId: credential.issuerKeyId,
      schemaVersion: credential.schemaVersion,
    });

    const publicKey = crypto.createPublicKey(issuer.publicKeyPem);
    const signature = Buffer.from(credential.issuerSignature, 'base64');
    const isValidSignature = crypto.verify(null, Buffer.from(payload), publicKey, signature);

    if (!isValidSignature) {
      res.json({ status: 'INVALID_SIGNATURE', credentialId: credential.id });
      return;
    }

    const anchorEvidence = await checkOnChainEvidence(credential);
    if (anchorEvidence.status === 'ANCHOR_UNAVAILABLE') {
      res.status(503).json({ status: 'ANCHOR_UNAVAILABLE', credentialId: credential.id });
      return;
    }
    if (anchorEvidence.status === 'BATCH_ROOT_MISMATCH' || anchorEvidence.status === 'INVALID_MERKLE_PROOF') {
      res.json({ status: 'INVALID_ANCHOR_EVIDENCE', credentialId: credential.id, anchorStatus: anchorEvidence.status });
      return;
    }
    if (anchorEvidence.revoked) {
      res.json({ status: revokedCredentialStatus, credentialId: credential.id, lifecycleStatus: 'REVOKED', anchorStatus: 'CONFIRMED_REVOKED' });
      return;
    }
    if (credential.lifecycleStatus === 'REVOKED' && credential.anchorState === 'ANCHORED') {
      res.json({ status: 'REVOCATION_PENDING', credentialId: credential.id, lifecycleStatus: credential.lifecycleStatus, anchorStatus: anchorEvidence.status });
      return;
    }
    if (credential.lifecycleStatus === 'REVOKED' || credential.lifecycleStatus === 'SUPERSEDED') {
      res.json({ status: revokedCredentialStatus, credentialId: credential.id, lifecycleStatus: credential.lifecycleStatus, anchorStatus: anchorEvidence.status });
      return;
    }

    res.json({
      status: 'VALID',
      credentialId: credential.id,
      issuerId: issuer.id,
      issuedAt: credential.issuedAt,
      lifecycleStatus: credential.lifecycleStatus,
      documentDigest: credential.documentDigest,
      anchorStatus: anchorEvidence.status,
      anchorBatchId: credential.anchorBatchId,
      anchorRoot: credential.anchorRoot,
      anchorTransactionHash: credential.anchorTransactionHash,
      anchorBlockNumber: credential.anchorBlockNumber,
    });
  });

  app.get('/api/v1/verify/:credentialId', (req, res) => {
    const credential = credentials.find((entry) => entry.id === req.params.credentialId);
    if (!credential) {
      res.status(404).json({ status: 'UNKNOWN_CREDENTIAL' });
      return;
    }
    res.json({ status: credential.lifecycleStatus, credentialId: credential.id });
  });

  app.post('/api/v1/auth/logout', (_req, res) => {
    res.json({ ok: true, message: 'logged_out' });
  });

  return app;
}
