import { config } from '../config/env.js';
import { redis } from '../db/redis.js';
import { HttpError } from '../lib/http-error.js';

// Backlog M4 — one account must not be able to hold a whole screen.
//
// A fixed window in Redis, counted per user. Redis rather than a Map in this
// process, because after M3 there are several processes behind a load balancer
// with no sticky sessions: an in-process counter would give one user N holds
// per instance, and the limit would quietly become three times what it says.
// The same Redis that already owns hold state owns the counter.
//
// A FIXED window, not a sliding one. Its known weakness is the boundary — a
// user can spend the limit at the end of one window and again at the start of
// the next, so the true worst case is 2x the limit across two windows. A
// sliding window means storing a timestamp per request per user, which is more
// memory and more moving parts than the thing being prevented is worth. The
// limit exists to stop one account sweeping a screen, not to meter billing.
//
// It counts REQUESTS, not seats. A request is what costs the server work, and
// the six-seat ceiling already bounds seats per request; counting seats would
// duplicate a rule that lives in the client and in holdService.

const KEY_PREFIX = 'ratelimit:holds';

// Atomic on purpose. INCR and EXPIRE as two round trips leaves a window where a
// process dying between them strands a key with no TTL — and a key with no TTL
// is a user locked out permanently. The script is the same shape holdService
// uses for the same reason: Redis is the only participant that sees every
// caller.
const COUNT_SCRIPT = `
  local n = redis.call('incr', KEYS[1])
  if n == 1 then
    redis.call('expire', KEYS[1], ARGV[1])
  end
  return { n, redis.call('ttl', KEYS[1]) }
`;

export function rateLimitKey(userId) {
  return `${KEY_PREFIX}:${userId}`;
}

/**
 * Whether the limiter does anything at all.
 *
 * Either value at zero turns it off, so a benchmark can disable it with one
 * variable and a misconfigured window cannot silently become a one-second one.
 */
export function limiterEnabled() {
  return config.holdRateLimit > 0 && config.holdRateWindowSeconds > 0;
}

/**
 * Limit hold creation per user.
 *
 * FAILS OPEN. If Redis cannot be reached the request is allowed through, and
 * holdService immediately refuses it with 503 HOLDS_UNAVAILABLE anyway, because
 * holds are a hard Redis dependency. Failing closed here would change nothing
 * except which error the user sees, while adding a way for a limiter fault to
 * take down a path that was working.
 *
 * Mounted after requireAuth, so req.user is always present.
 */
export async function rateLimitHolds(req, res, next) {
  if (!limiterEnabled()) return next();
  if (!redis?.isReady) return next();

  let count;
  let ttl;

  try {
    [count, ttl] = await redis.eval(COUNT_SCRIPT, {
      keys: [rateLimitKey(req.user.id)],
      arguments: [String(config.holdRateWindowSeconds)],
    });
  } catch (err) {
    // Observed, not fatal. The limiter is a guard rail, not the guarantee.
    console.error('rate limit: count failed, allowing the request', err);
    return next();
  }

  if (count <= config.holdRateLimit) return next();

  // Seconds until the window resets. A negative TTL means the key lost its
  // expiry, which the script above is written to prevent; the window length is
  // the honest upper bound if it ever happens.
  const retryAfter = ttl > 0 ? ttl : config.holdRateWindowSeconds;
  res.set('Retry-After', String(retryAfter));

  next(
    new HttpError(
      429,
      'RATE_LIMITED',
      `Too many hold requests. Try again in ${retryAfter} seconds`,
    ),
  );
}
