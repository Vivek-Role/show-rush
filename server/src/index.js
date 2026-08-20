import { createApp } from './app.js';
import { config, missingConnectionVars } from './config/env.js';
import { closePool } from './db/pool.js';
import { closeRedis, connectRedis } from './db/redis.js';

for (const name of missingConnectionVars()) {
  console.error(`${name} is not set`);
}

// Reported, not fatal — the same treatment the connection strings get. The API
// stays fully usable by curl, k6 and any non-browser client; only cross-origin
// browser requests are refused.
if (!config.clientOrigin) {
  console.error('CLIENT_ORIGIN is not set — browser clients will be blocked by CORS');
}

connectRedis();

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`show-rush listening on port ${config.port}`);
});

// Render sends SIGTERM on every deploy and shutdown. Stop accepting requests
// first, then close the data clients, so neither is torn down mid-query.
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);

  server.close();
  server.closeAllConnections();

  await closePool();
  await closeRedis();

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
