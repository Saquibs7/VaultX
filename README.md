# Verified Document Vault

Verified Document Vault is a security-first academic credential platform that combines a credential issuance and verification service, a blockchain evidence layer, and a deterministic operational scheduler.

The project is designed to explain and demonstrate how a real system can keep trust, integrity, and operational safety separate:

- credential validity is checked by the API service,
- blockchain anchoring is evidence, not the source of trust,
- data collection and research are separate from production verification,
- learning and optimization are advisory and never override safety rules.

## What this repo contains

- API and credential subscription services for issuance, verification, and storage metadata
- a worker for deterministic batch assembly and transaction reconciliation
- Solidity contracts for batch-root registration and revocation controls
- deterministic scheduling and simulator baselines

## Repository structure

- apps/web: frontend and dashboard experience
- services/api: credential issuance, authentication, validation, and verification
- services/anchoring-worker: batch scheduling, transaction reconciliation, queue tracking
- contracts: Solidity registry and contract tests
- packages/crypto-protocol: canonical Merkle hashing and protocol helpers

## Run the complete local stack

Requirements: Docker Compose v2 and Node.js 22 or newer. From the repository root:

```bash
docker compose up --build -d
```

Open the issuer portal at [http://localhost:8080](http://localhost:8080). The API, MongoDB, Hardhat node, registry deployment job, and anchoring worker start in dependency order. Local demo setup is enabled only outside production. Create an institution and first issuer from the sign-in screen; then issue a document, wait for the worker to anchor it, and verify or revoke it.

Run the end-to-end issuance, on-chain inclusion, and on-chain revocation smoke check with:

```bash
npm run smoke:compose
```

MongoDB stores local credentials and encrypted documents in a named volume. `docker compose down` stops the services without deleting that data; `docker compose down -v` removes the local database and deployment volumes. Compose defaults are local development values only. Before exposing this stack, set strong `JWT_ACCESS_SECRET`, 64-hex-character `DOCUMENT_ENCRYPTION_KEY`, and `WORKER_API_KEY` values in `.env`, and set `NODE_ENV=production` only after using persistent storage and a production RPC/key-management setup.

The API currently stores issuer signing private keys in its database and uses the local Hardhat account for anchoring. These are development arrangements, not production key custody. Do not reuse the Compose defaults on a public network.
