import assert from 'node:assert/strict';
import { test } from 'node:test';

// BACKLOG.md F-2 — a malformed pool size must refuse to start.
//
// This lives in its own file because the value is read once, at import: one
// process can only hold one DB_POOL_MAX, and the valid path is covered by
// db/pool.test.js. Under `node --test` each file is its own process, which is
// what makes both halves observable.
//
// The refusal matters more than the usual "validate your env" reflex. pg treats
// a NaN max as unset and silently substitutes its own default of 10 — so a typo
// would leave the pool at exactly the ceiling this finding is about, looking
// configured and behaving as though it never had been.
process.env.DB_POOL_MAX = 'sixty';

const { config, assertPoolConfig } = await import('./env.js');

test('a malformed DB_POOL_MAX parses to NaN rather than the default', () => {
  assert.ok(Number.isNaN(config.dbPoolMax));
});

test('a malformed DB_POOL_MAX refuses to start, and names the value', () => {
  assert.throws(() => assertPoolConfig(), /DB_POOL_MAX must be a positive integer/);
  assert.throws(() => assertPoolConfig(), /sixty/);
});

// 0 and a negative are covered by writing config directly rather than by
// another process per value. assertPoolConfig() reads config, and config is a
// plain object — so this exercises the real assertion, and each case restores
// what it changed.
test('a pool of zero is an error, not a way to switch the pool off', () => {
  const original = config.dbPoolMax;
  try {
    config.dbPoolMax = 0;
    // pg accepts 0 and then never creates a client, so every query waits
    // forever. Unlike RECONCILE_INTERVAL_SECONDS=0 or HOLD_RATE_LIMIT=0, this
    // disables nothing — it hangs.
    assert.throws(() => assertPoolConfig(), /positive integer/);
  } finally {
    config.dbPoolMax = original;
  }
});

test('a negative pool size refuses to start', () => {
  const original = config.dbPoolMax;
  try {
    config.dbPoolMax = -1;
    assert.throws(() => assertPoolConfig(), /positive integer/);
  } finally {
    config.dbPoolMax = original;
  }
});

test('a valid pool size is accepted', () => {
  const original = config.dbPoolMax;
  try {
    config.dbPoolMax = 10;
    assert.doesNotThrow(() => assertPoolConfig());
  } finally {
    config.dbPoolMax = original;
  }
});
