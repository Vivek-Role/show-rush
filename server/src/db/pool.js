import pg from 'pg';
import { config } from '../config/env.js';

// Neon requires TLS and advertises it via sslmode=require; local Docker has no
// TLS. Certificate verification stays on either way.
export const pool = config.databaseUrl
  ? new pg.Pool({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: 3000,
      ...(/[?&]sslmode=require/.test(config.databaseUrl)
        ? { ssl: { rejectUnauthorized: true } }
        : {}),
    })
  : null;

// An idle client losing its connection emits on the pool. Unhandled, that
// kills the process — Postgres going down must degrade /health, not crash.
if (pool) pool.on('error', () => {});

export async function closePool() {
  if (!pool) return;
  await pool.end().catch(() => {});
}
