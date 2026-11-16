FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/api/package.json services/api/package.json
COPY services/anchoring-worker/package.json services/anchoring-worker/package.json
COPY packages/crypto-protocol/package.json packages/crypto-protocol/package.json
RUN npm ci
COPY . .
RUN npm run build --workspace @verified-document-vault/crypto-protocol
RUN npm run build --workspace @verified-document-vault/anchoring-worker
CMD ["npm", "run", "start", "--workspace", "@verified-document-vault/anchoring-worker"]
