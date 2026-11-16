FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/api/package.json services/api/package.json
COPY services/anchoring-worker/package.json services/anchoring-worker/package.json
COPY packages/crypto-protocol/package.json packages/crypto-protocol/package.json
RUN npm ci
COPY . .
RUN npm run build --workspace @verified-document-vault/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=10 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
