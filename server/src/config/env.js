import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// npm start runs with cwd=server/, so the repo-root .env must be resolved
// explicitly. On Render there is no .env and the platform supplies the vars.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../../.env'), quiet: true });

// .env.example is the single source of truth for these names. Anything reading
// an env var not listed there is a bug.
export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT) || 3000,
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
};

// Unlike the connection strings, a missing signing secret is fatal: signing
// with an empty or defaulted secret would make every token forgeable, so
// degrading is not an option. authService calls this at import, which means
// the server refuses to start without it while the migration runner — which
// needs no secret — is unaffected.
export function assertAuthConfig() {
  if (!config.jwtSecret) {
    throw new Error('JWT_SECRET is not set. See .env.example.');
  }
}

// Absent connection strings are reported, not fatal: both clients default to
// localhost when handed nothing, which can silently connect to an unrelated
// service. Missing config degrades /health to 503 rather than killing the
// process, which is the behaviour Phase 0 verified.
export function missingConnectionVars() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.redisUrl) missing.push('REDIS_URL');
  return missing;
}
