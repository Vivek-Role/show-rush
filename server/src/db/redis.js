import { createClient } from 'redis';
import { config } from '../config/env.js';

export const redis = config.redisUrl
  ? createClient({ url: config.redisUrl, socket: { connectTimeout: 3000 } })
  : null;

// Without a listener an emitted error is fatal. /health reports the state
// instead, so a down Redis degrades the service rather than killing it.
if (redis) redis.on('error', () => {});

// Connecting is the bootstrap's call, not a side effect of importing this
// module — importing it must stay safe for scripts that never need Redis.
export function connectRedis() {
  if (!redis) return;
  redis.connect().catch(() => {});
}

export async function closeRedis() {
  if (!redis?.isOpen) return;
  await redis.quit().catch(() => {});
}
