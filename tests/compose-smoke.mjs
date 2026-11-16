#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';

const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
const webUrl = process.env.WEB_URL ?? 'http://localhost:8080';
const password = process.env.DEMO_ISSUER_PASSWORD ?? `M6-Smoke-${Date.now()}-Pass!`;

async function request(path, init = {}, token) {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body !== undefined && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  const response = await fetch(new URL(path, apiUrl), { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForCredential(token, credentialId, predicate, label, timeoutMs = 30_000) {
  const stopAt = Date.now() + timeoutMs;
  let last;
  while (Date.now() < stopAt) {
    const result = await request('/api/v1/credentials', {}, token);
    last = result.items.find((credential) => credential.id === credentialId);
    if (last && predicate(last)) return last;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}; last state was ${last?.lifecycleStatus}/${last?.anchorState}/${last?.revocationState}`);
}

async function main() {
  const webResponse = await fetch(webUrl);
  const webHtml = await webResponse.text();
  if (!webResponse.ok || !webHtml.includes('/assets/index-')) {
    throw new Error('The frontend web bundle is not being served');
  }
  const proxiedHealthResponse = await fetch(new URL('/health', webUrl));
  if (!proxiedHealthResponse.ok) throw new Error('The frontend reverse proxy cannot reach the API health endpoint');
  const health = await request('/health');
  if (health.ok !== true || health.persistence !== 'durable' || health.blockchain !== 'connected') {
    throw new Error(`Compose services are not fully ready: ${JSON.stringify(health)}`);
  }

  const unique = Date.now().toString(36);
  const institution = await request('/api/v1/institutions', {
    method: 'POST',
    body: JSON.stringify({ name: `M6 Smoke University ${unique}` }),
  });
  const email = `m6-smoke-${unique}@example.edu`;
  const issuer = await request(`/api/v1/institutions/${institution.id}/issuers`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Integration Registrar', email, password, role: 'ISSUER' }),
  });
  const login = await request('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  const originalBytes = Buffer.from(`%PDF-1.4\nVerified Document Vault E2E ${unique}\n%%EOF\n`);
  const issueForm = new FormData();
  issueForm.set('holderReference', `m6-holder-${unique}`);
  issueForm.set('credentialVersion', '1');
  issueForm.set('issuerId', issuer.id);
  issueForm.set('credentialFile', new Blob([originalBytes], { type: 'application/pdf' }), 'credential.pdf');
  const issued = await request('/api/v1/credentials', { method: 'POST', body: issueForm }, login.token);
  const anchored = await waitForCredential(login.token, issued.id, (credential) => credential.lifecycleStatus === 'ANCHORED', 'on-chain anchor');

  const verificationForm = new FormData();
  verificationForm.set('credentialId', anchored.id);
  verificationForm.set('credentialFile', new Blob([originalBytes], { type: 'application/pdf' }), 'credential.pdf');
  const valid = await request('/api/v1/verify', { method: 'POST', body: verificationForm });
  if (valid.status !== 'VALID' || valid.anchorStatus !== 'CONFIRMED') {
    throw new Error(`Expected signature and inclusion proof to verify, got ${JSON.stringify(valid)}`);
  }

  const revocation = await request(`/api/v1/credentials/${anchored.id}/revoke`, { method: 'POST' }, login.token);
  if (!['REVOCATION_PENDING', 'REVOKED'].includes(revocation.status)) {
    throw new Error(`Unexpected revocation result ${JSON.stringify(revocation)}`);
  }
  const revoked = await waitForCredential(login.token, anchored.id, (credential) => credential.revocationState === 'CONFIRMED', 'on-chain revocation');
  const revokedVerification = await request('/api/v1/verify', { method: 'POST', body: verificationForm });
  if (revokedVerification.status !== 'REVOKED_CREDENTIAL') {
    throw new Error(`Expected on-chain revocation to invalidate verification, got ${JSON.stringify(revokedVerification)}`);
  }

  console.log(JSON.stringify({
    status: 'passed',
    webUrl,
    frontendServed: true,
    frontendApiProxy: 'healthy',
    health,
    institutionId: institution.id,
    issuerId: issuer.id,
    credentialId: anchored.id,
    batchId: anchored.anchorBatchId,
    anchorTransactionHash: anchored.anchorTransactionHash,
    anchorBlockNumber: anchored.anchorBlockNumber,
    initialVerification: valid.status,
    revocationState: revoked.revocationState,
    revocationTransactionHash: revoked.revocationTransactionHash,
    postRevocationVerification: revokedVerification.status,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
