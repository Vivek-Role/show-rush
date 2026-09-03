import pg from 'pg';
import { assertPoolConfig, config } from '../config/env.js';

// F-2. Checked before the pool is built, so a bad value cannot reach pg —
// which would accept it and fall back to its own default.
assertPoolConfig();

// Neon requires TLS and advertises it via sslmode=require; local Docker has no
// TLS. Certificate verification stays on either way.
export const pool = config.databaseUrl
  ? new pg.Pool({
      connectionString: config.databaseUrl,
      // BACKLOG.md F-2 — stated rather than inherited. pg's implicit default is
      // also 10, so this line changes no behaviour by design; what it changes
      // is that the ceiling is now a decision the repository has made and can
      // move, instead of a library default nobody chose. See config/env.js for
      // why the number is 10 and what must happen before it is anything else.
      max: config.dbPoolMax,
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
