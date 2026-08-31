import assert from 'node:assert/strict';
import { test } from 'node:test';

// The safety properties that must hold without a Redis to talk to.
//
// The limiting itself is a Redis counter, so what a unit test can pin down is
// everything around it: the key shape, when the limiter is off, and — the one
// that matters — that a missing Redis lets the request through rather than
// turning a guard rail into an outage. The counting behaviour is verified
// against the running stack instead, and recorded with the rest of M4.
//
// REDIS_URL is emptied and the limits are set before the modules load. dotenv
// does not override variables already present in process.env, so these win over
// the repository's .env — and nothing here can open a socket, so a Redis
// running on this machine cannot make the test pass by accident.
process.env.REDIS_URL = '';
process.env.HOLD_RATE_LIMIT = '5';
process.env.HOLD_RATE_WINDOW_SECONDS = '60';

const { redis } = await import('../db/redis.js');
const { limiterEnabled, rateLimitHolds, rateLimitKey } = await import('./rateLimit.js');

function call() {
  const calls = [];
  const res = { set: () => res };
  const next = (err) => calls.push(err);
  return { req: { user: { id: 7 } }, res, next, calls };
}

test('the key is scoped to holds and to one user', () => {
  assert.equal(rateLimitKey(7), 'ratelimit:holds:7');
  assert.notEqual(rateLimitKey(7), rateLimitKey(8));
});

test('a configured limit turns the limiter on', () => {
  assert.equal(limiterEnabled(), true);
});

test('a missing Redis lets the request through', async () => {
  // Fails open on purpose: holds are a hard Redis dependency, so holdService
  // refuses this request a moment later with 503 anyway. The limiter must not
  // be the thing that breaks a path Redis was already going to break.
  assert.equal(redis, null);

  const { req, res, next, calls } = call();
  await rateLimitHolds(req, res, next);

  assert.equal(calls.length, 1);
  assert.equal(calls[0], undefined, 'next() was called with no error');
});

test('failing open does not set Retry-After', async () => {
  let header = null;
  const { req, next } = call();
  const res = {
    set: (name, value) => {
      header = [name, value];
      return res;
    },
  };

  await rateLimitHolds(req, res, next);

  assert.equal(header, null);
});
