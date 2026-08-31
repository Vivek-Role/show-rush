import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { record, resetMetrics, snapshot } from './metrics.js';

beforeEach(() => resetMetrics());

test('an empty registry reports no routes', () => {
  assert.deepEqual(snapshot().routes, {});
});

test('count, min, max and mean are exact', () => {
  for (const ms of [10, 20, 30]) record('GET /x', ms);

  const route = snapshot().routes['GET /x'];
  assert.equal(route.count, 3);
  assert.equal(route.min_ms, 10);
  assert.equal(route.max_ms, 30);
  assert.equal(route.mean_ms, 20);
});

test('percentiles are the upper bound of the bucket holding the sample', () => {
  // 100 observations at 10 ms. The bucket bounds bracket 10 exactly, so every
  // percentile lands on the 10 ms bound.
  for (let i = 0; i < 100; i += 1) record('GET /x', 10);

  const route = snapshot().routes['GET /x'];
  assert.equal(route.p50_ms, 12);
  assert.equal(route.p95_ms, 12);
  assert.equal(route.p99_ms, 12);
});

test('a slow tail moves p99 without moving p50', () => {
  // 95 fast and 5 slow, not 99 and 1. p99 is the ceil(0.99 x n)-th sample, so a
  // single outlier in a hundred sits at position 100 and p99 correctly stays
  // fast. Five is the smallest tail that actually reaches the 99th sample, and
  // getting this wrong is the usual way a percentile assertion lies.
  for (let i = 0; i < 95; i += 1) record('GET /x', 2);
  for (let i = 0; i < 5; i += 1) record('GET /x', 900);

  const route = snapshot().routes['GET /x'];
  assert.equal(route.count, 100);
  assert.ok(route.p50_ms <= 3, `p50 should stay fast, got ${route.p50_ms}`);
  assert.ok(route.p99_ms >= 800, `p99 should show the tail, got ${route.p99_ms}`);
  assert.equal(route.max_ms, 900);
});

test('a single outlier in a hundred does not reach p99', () => {
  for (let i = 0; i < 99; i += 1) record('GET /x', 2);
  record('GET /x', 900);

  const route = snapshot().routes['GET /x'];
  assert.ok(route.p99_ms <= 3, `one in a hundred sits past p99, got ${route.p99_ms}`);
  assert.equal(route.max_ms, 900, 'but max still reports it');
});

test('an observation past the last bound reports the observed max', () => {
  record('GET /x', 90000);

  const route = snapshot().routes['GET /x'];
  assert.equal(route.p99_ms, 90000);
  assert.equal(route.max_ms, 90000);
});

test('routes are kept apart', () => {
  record('GET /a', 5);
  record('POST /b', 500);

  const { routes } = snapshot();
  assert.equal(routes['GET /a'].count, 1);
  assert.equal(routes['POST /b'].count, 1);
  assert.notEqual(routes['GET /a'].p50_ms, routes['POST /b'].p50_ms);
});

test('memory is bounded: 100k observations do not grow the structure', () => {
  for (let i = 0; i < 100000; i += 1) record('GET /x', i % 300);

  const { routes, bucket_bounds_ms: bounds } = snapshot();
  assert.equal(routes['GET /x'].count, 100000);
  // One route key, and the summary has a fixed number of fields regardless of
  // how many observations went in — the property that makes this safe on the
  // hot path.
  assert.equal(Object.keys(routes).length, 1);
  assert.equal(Object.keys(routes['GET /x']).length, 7);
  assert.ok(bounds.length < 30);
});

test('nonsense observations are ignored rather than corrupting a route', () => {
  record('GET /x', Number.NaN);
  record('GET /x', -5);
  record('GET /x', Number.POSITIVE_INFINITY);
  record('GET /x', 10);

  const route = snapshot().routes['GET /x'];
  assert.equal(route.count, 1);
  assert.equal(route.max_ms, 10);
});

test('reset clears everything', () => {
  record('GET /x', 10);
  resetMetrics();
  assert.deepEqual(snapshot().routes, {});
});
