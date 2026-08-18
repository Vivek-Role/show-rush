import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import pg from 'pg';
import { createClient } from 'redis';

// Phase 0 is deliberately a single file. routes/, services/ and db/ are
// Phase 1.1's deliverable — see PLAN.md and docs/phases/phase-0-setup.md (D2).

// npm start runs with cwd=server/, so the repo-root .env must be resolved
// explicitly. On Render there is no .env and the platform supplies the vars.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env'), quiet: true });

const app = express();
const port = Number(process.env.PORT) || 3000;

const databaseUrl = process.env.DATABASE_URL ?? '';
const redisUrl = process.env.REDIS_URL ?? '';

// Both clients default to localhost when handed nothing, which can silently
// connect to an unrelated service. Absent config is an error, not a default.
if (!databaseUrl) console.error('DATABASE_URL is not set');
if (!redisUrl) console.error('REDIS_URL is not set');

// Neon requires TLS and advertises it via sslmode=require; local Docker has no
// TLS. Certificate verification stays on either way.
const pool = databaseUrl
  ? new pg.Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 3000,
      ...(/[?&]sslmode=require/.test(databaseUrl)
        ? { ssl: { rejectUnauthorized: true } }
        : {}),
    })
  : null;

// An idle client losing its connection emits on the pool. Unhandled, that
// kills the process — Postgres going down must degrade /health, not crash.
if (pool) pool.on('error', () => {});

const redis = redisUrl
  ? createClient({ url: redisUrl, socket: { connectTimeout: 3000 } })
  : null;

if (redis) {
  // Without a listener an emitted error is fatal. /health reports the state
  // instead, so a down Redis degrades the service rather than killing it.
  redis.on('error', () => {});
  redis.connect().catch(() => {});
}

app.get('/', (req, res) => {
  res.json({ service: 'show-rush', status: 'ok' });
});

app.get('/health', async (req, res) => {
  const [db, cache] = await Promise.all([
    pool
      ? pool
          .query('select 1')
          .then(() => 'ok')
          .catch(() => 'error')
      : Promise.resolve('error'),
    redis?.isOpen
      ? redis
          .ping()
          .then(() => 'ok')
          .catch(() => 'error')
      : Promise.resolve('error'),
  ]);

  // Status only — never versions, hosts, or error detail that leaks topology.
  const healthy = db === 'ok' && cache === 'ok';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    db,
    redis: cache,
  });
});

app.listen(port, () => {
  console.log(`show-rush listening on port ${port}`);
});
