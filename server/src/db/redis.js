import { createClient } from 'redis';
import { config } from '../config/env.js';

export const redis = config.redisUrl
  ? createClient({ url: config.redisUrl, socket: { connectTimeout: 3000 } })
  : null;

// Without a listener an emitted error is fatal. /health reports the state
// instead, so a down Redis degrades the service rather than killing it.
if (redis) redis.on('error', () => {});

// Phase 9 M3. A second connection, for the seat channel's subscriber.
//
// Not a convenience: a Redis client in subscribe mode cannot issue ordinary
// commands, and the client above is on the hold path serving SET, GET and MGET.
// duplicate() copies this client's URL and options rather than re-reading
// config, so the two can never end up pointed at different servers. It is
// returned unconnected — connecting is the caller's call, the same rule the
// module applies to itself below.
export function createSubscriber() {
  if (!redis) return null;
  return redis.duplicate();
}

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
