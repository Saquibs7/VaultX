import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const nodeEnv = process.env.NODE_ENV ?? 'development';
const jwtSecret = process.env.JWT_ACCESS_SECRET;
const documentEncryptionKey = process.env.DOCUMENT_ENCRYPTION_KEY;
const mongoUri = process.env.MONGODB_URI;
const workerApiKey = process.env.WORKER_API_KEY;
const registryAddress = process.env.CONTRACT_ADDRESS;
const registryDeploymentFile = process.env.DEPLOYMENT_FILE;

if (nodeEnv === 'production') {
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('JWT_ACCESS_SECRET must be set to at least 32 characters in production');
  }
  if (!documentEncryptionKey || !/^[0-9a-fA-F]{64}$/.test(documentEncryptionKey)) {
    throw new Error('DOCUMENT_ENCRYPTION_KEY must be a 32-byte hexadecimal key in production');
  }
  if (!mongoUri) {
    throw new Error('MONGODB_URI must be set in production');
  }
  if (!workerApiKey || workerApiKey.length < 32) {
    throw new Error('WORKER_API_KEY must be set to at least 32 characters in production');
  }
  if (!registryAddress && !registryDeploymentFile) {
    throw new Error('CONTRACT_ADDRESS or DEPLOYMENT_FILE must be set in production');
  }
}

export const config = {
  nodeEnv,
  port: Number(process.env.PORT ?? 3000),
  jwtSecret: jwtSecret ?? 'local-development-jwt-secret-not-for-production',
  allowDemoBootstrap: nodeEnv !== 'production',
  demoIssuerPassword: process.env.DEMO_ISSUER_PASSWORD ?? 'Password123!',
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  mongoUri,
  workerApiKey,
  rpcUrl: process.env.RPC_URL ?? 'http://localhost:8545',
  chainId: BigInt(process.env.CHAIN_ID ?? '31337'),
  registryAddress,
  registryDeploymentFile,
  documentEncryptionKey:
    documentEncryptionKey ??
    crypto.createHash('sha256').update('verified-document-vault-local-dev').digest('hex'),
  maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_BYTES ?? 10 * 1024 * 1024),
  allowedMimeTypes: ['application/pdf', 'application/json', 'text/plain', 'image/png'],
};
