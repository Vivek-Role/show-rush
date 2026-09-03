import assert from 'node:assert/strict';
import { test } from 'node:test';

// BACKLOG.md F-2 — the pool ceiling is configured, not inherited.
//
// What a unit test can pin down here is the wiring: that DB_POOL_MAX reaches
// pg, and that building the pool opens nothing. It cannot say whether 10 is the
// right number — that is a benchmark, against a database, and the finding
// requires one before the value moves.
//
// DB_POOL_MAX is set before the modules load, and deliberately to something
// that is NOT pg's own default of 10: at 10 this test would pass just as well
// against the unconfigured pool it exists to distinguish from. dotenv does not
// override variables already present in process.env, so this wins over the
// repository's .env.
process.env.DB_POOL_MAX = '7';
// A syntactically valid URL pointing nowhere. pg resolves nothing until a query
// asks for a client, so no socket is opened by any of this.
process.env.DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';

const { config } = await import('../config/env.js');
const { pool } = await import('./pool.js');

test('DB_POOL_MAX is what the pool is built with', () => {
  assert.equal(config.dbPoolMax, 7);
  assert.equal(pool.options.max, 7);
});

test('the configured ceiling is not pg\'s implicit default', () => {
  // The whole point of F-2: 10 was never chosen, it was inherited. If this
  // assertion ever fails the test above has stopped proving anything.
  assert.notEqual(pool.options.max, 10);
});

test('building the pool opens no connections', () => {
  // Sizing a pool must not cost a connection at import. The seed scripts, the
  // migration runner and the reconcile CLI all import this module.
  assert.equal(pool.totalCount, 0);
  assert.equal(pool.idleCount, 0);
});
