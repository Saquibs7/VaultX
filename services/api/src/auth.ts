import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import { config } from './config.js';

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function signToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '1h' });
}

export function verifyToken(token: string): { id: string; institutionId: string; role: string } {
  const decoded = jwt.verify(token, config.jwtSecret) as { id: string; institutionId: string; role: string };
  return decoded;
}

export function createIssuerKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: `key_${crypto.randomBytes(8).toString('hex')}`,
  };
}

export function encryptIssuerPrivateKey(privateKeyPem: string): string {
  if (privateKeyPem.startsWith('enc:v1:')) return privateKeyPem;
  const nonce = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(config.documentEncryptionKey).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(privateKeyPem, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${nonce.toString('hex')}:${Buffer.concat([ciphertext, tag]).toString('base64')}`;
}

export function decryptIssuerPrivateKey(storedValue: string): string {
  if (!storedValue.startsWith('enc:v1:')) return storedValue;
  const [, , nonceHex, encoded] = storedValue.split(':');
  if (!nonceHex || !encoded) throw new Error('Stored issuer key encryption record is malformed');
  const encrypted = Buffer.from(encoded, 'base64');
  if (encrypted.length <= 16) throw new Error('Stored issuer key ciphertext is truncated');
  const key = crypto.createHash('sha256').update(config.documentEncryptionKey).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonceHex, 'hex'));
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
  return Buffer.concat([
    decipher.update(encrypted.subarray(0, encrypted.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptDocument(document: Buffer): { ciphertext: string; nonce: string; keyId: string } {
  const nonce = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(config.documentEncryptionKey).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(document), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: Buffer.concat([ciphertext, tag]).toString('base64'),
    nonce: nonce.toString('hex'),
    keyId: 'default-document-key',
  };
}

export function decryptDocument(encryptedDocument: string, nonceHex: string): Buffer {
  const key = crypto.createHash('sha256').update(config.documentEncryptionKey).digest();
  const buffer = Buffer.from(encryptedDocument, 'base64');
  const tagLength = 16;
  const ciphertext = buffer.subarray(0, buffer.length - tagLength);
  const tag = buffer.subarray(buffer.length - tagLength);
  const nonce = Buffer.from(nonceHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
