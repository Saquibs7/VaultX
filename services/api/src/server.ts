import { createApp } from './app.js';
import { config } from './config.js';

const app = await createApp();
const server = app.listen(config.port, () => {
  console.log(`Verified Document Vault API listening on http://localhost:${config.port}`);
});

async function shutdown() {
  server.close(async () => {
    await app.locals.persistence?.close();
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
