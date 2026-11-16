import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app';

let server: ReturnType<typeof import('http').createServer> | undefined;
let baseUrl = '';

beforeAll(async () => {
  const app = await createApp();
  server = app.listen(0, () => {
    const address = server?.address();
    if (address && typeof address !== 'string') {
      baseUrl = `http://127.0.0.1:${address.port}`;
    }
  });

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (baseUrl) {
        clearInterval(timer);
        resolve(undefined);
      }
    }, 10);
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

describe('credential MVP', () => {
  it('issues a valid credential and verifies the original document', async () => {
    const institutionResponse = await fetch(`${baseUrl}/api/v1/institutions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Northbridge University' }),
    });

    expect(institutionResponse.status).toBe(201);
    const institution = await institutionResponse.json();

    const issuerResponse = await fetch(`${baseUrl}/api/v1/institutions/${institution.id}/issuers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Registrar Office', role: 'ISSUER' }),
    });

    expect(issuerResponse.status).toBe(201);
    const issuer = await issuerResponse.json();

    const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: issuer.email, password: 'Password123!' }),
    });

    expect(loginResponse.status).toBe(200);
    const login = await loginResponse.json();
    expect(login.token).toBeDefined();

    const originalDocument = '%PDF-1.4\nstudent transcript body\n%%EOF';
    const file = new Blob([originalDocument], { type: 'application/pdf' });
    const form = new FormData();
    form.append('holderReference', 'student-123');
    form.append('credentialVersion', '1');
    form.append('issuerId', issuer.id);
    form.append('credentialFile', file, 'transcript.pdf');

    const credentialResponse = await fetch(`${baseUrl}/api/v1/credentials`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${login.token}`,
      },
      body: form,
    });

    expect(credentialResponse.status).toBe(201);
    const credential = await credentialResponse.json();
    expect(credential.documentDigest).toBeDefined();
    expect(credential.lifecycleStatus).toBe('PENDING_ANCHOR');

    const verificationResponse = await fetch(`${baseUrl}/api/v1/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        credentialId: credential.id,
        document: originalDocument,
      }),
    });

    expect(verificationResponse.status).toBe(200);
    const verification = await verificationResponse.json();
    expect(verification.status).toBe('VALID');
  });

  it('rejects a modified document even when the credential exists', async () => {
    const institutionResponse = await fetch(`${baseUrl}/api/v1/institutions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harbor Technical College' }),
    });

    const institution = await institutionResponse.json();
    const issuerResponse = await fetch(`${baseUrl}/api/v1/institutions/${institution.id}/issuers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Admissions', role: 'ISSUER' }),
    });
    const issuer = await issuerResponse.json();

    const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: issuer.email, password: 'Password123!' }),
    });
    const login = await loginResponse.json();

    const file = new Blob(['hello world'], { type: 'text/plain' });
    const form = new FormData();
    form.append('holderReference', 'student-456');
    form.append('credentialVersion', '2');
    form.append('issuerId', issuer.id);
    form.append('credentialFile', file, 'note.txt');

    const issued = await fetch(`${baseUrl}/api/v1/credentials`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}` },
      body: form,
    });
    const credential = await issued.json();

    const verificationResponse = await fetch(`${baseUrl}/api/v1/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credentialId: credential.id,
        document: 'hello world modified',
      }),
    });

    expect(verificationResponse.status).toBe(200);
    const verification = await verificationResponse.json();
    expect(verification.status).toBe('INVALID_DOCUMENT');
  });

  it('rejects malformed uploads and unknown credential verification requests', async () => {
    const institutionResponse = await fetch(`${baseUrl}/api/v1/institutions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Royal Institute' }),
    });
    const institution = await institutionResponse.json();
    const issuerResponse = await fetch(`${baseUrl}/api/v1/institutions/${institution.id}/issuers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Compliance Office', role: 'ISSUER' }),
    });
    const issuer = await issuerResponse.json();

    const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: issuer.email, password: 'Password123!' }),
    });
    const login = await loginResponse.json();

    const badFile = new Blob([new Uint8Array([0xff, 0x00, 0x1a, 0x33, 0x99, 0x42])], { type: 'application/octet-stream' });
    const badForm = new FormData();
    badForm.append('holderReference', 'student-789');
    badForm.append('credentialVersion', '7');
    badForm.append('issuerId', issuer.id);
    badForm.append('credentialFile', badFile, 'malware.bin');

    const uploadResponse = await fetch(`${baseUrl}/api/v1/credentials`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}` },
      body: badForm,
    });

    expect(uploadResponse.status).toBe(400);

    const unknownVerification = await fetch(`${baseUrl}/api/v1/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId: 'cred_unknown', document: 'abc' }),
    });

    expect(unknownVerification.status).toBe(404);
    const unknownBody = await unknownVerification.json();
    expect(unknownBody.status).toBe('UNKNOWN_CREDENTIAL');
  });

  it('rejects arbitrary bytes even when the client labels them as a PDF', async () => {
    const institutionResponse = await fetch(`${baseUrl}/api/v1/institutions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Byte Validation Institute' }),
    });
    const institution = await institutionResponse.json();
    const issuerResponse = await fetch(`${baseUrl}/api/v1/institutions/${institution.id}/issuers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Issuer' }),
    });
    const issuer = await issuerResponse.json();
    const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: issuer.email, password: 'Password123!' }),
    });
    const login = await loginResponse.json();
    const form = new FormData();
    form.append('holderReference', 'student-mime-check');
    form.append('credentialVersion', '1');
    form.append('issuerId', issuer.id);
    form.append('credentialFile', new Blob([new Uint8Array([0xff, 0x00, 0x1a, 0x33, 0x99, 0x42])], { type: 'application/pdf' }), 'fake.pdf');

    const uploadResponse = await fetch(`${baseUrl}/api/v1/credentials`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}` },
      body: form,
    });

    expect(uploadResponse.status).toBe(400);
    expect((await uploadResponse.json()).error).toBe('unsupported_file_type');
  });
});
