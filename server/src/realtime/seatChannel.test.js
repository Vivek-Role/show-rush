import assert from 'node:assert/strict';
import { test } from 'node:test';

// The degraded contract, and only that.
//
// hub.js decides whether to deliver a seat change locally purely from what this
// module reports: publishSeats() returning false means the message reached
// nobody, so broadcastSeats must hand it to its own sockets itself. Getting
// that answer wrong in either direction is the difference between a silently
// dropped update and the same update delivered twice — which is exactly what
// the multi-instance verification run measured, and what this test pins down
// without needing a Redis to talk to.
//
// REDIS_URL is emptied before the modules load. dotenv does not override a
// variable that is already present in process.env, so this wins over the
// repository's .env and config.redisUrl comes out falsy — the no-Redis path.
// It also keeps the test honest: nothing here opens a socket, so a Redis that
// happens to be running on this machine cannot make it pass.
process.env.REDIS_URL = '';

const { createSubscriber, redis } = await import('../db/redis.js');
const { closeSeatChannel, connectSeatChannel, publishSeats, seatChannelReady } =
  await import('./seatChannel.js');

test('no REDIS_URL means no client at all', () => {
  assert.equal(redis, null);
  assert.equal(createSubscriber(), null);
});

test('the channel is not ready before it is connected', () => {
  assert.equal(seatChannelReady(), false);
});

test('publishing without a channel reports false rather than throwing', async () => {
  assert.equal(await publishSeats({ show_id: '1', seats: [{ id: '1', status: 'held' }] }), false);
});

test('connecting without a URL is survivable and leaves the channel unready', async () => {
  // Non-fatal by design: an instance that cannot reach the channel still serves
  // HTTP, still holds seats, and still tells its own sockets what changed.
  await connectSeatChannel(() => {});

  assert.equal(seatChannelReady(), false);
});

test('publishing still reports false after a failed connect', async () => {
  // The value hub.js branches on, in the state it will actually be in when
  // Redis is missing — false, so the caller delivers locally.
  assert.equal(await publishSeats({ show_id: '1', seats: [{ id: '1', status: 'held' }] }), false);
});

test('closing a channel that was never opened is safe', async () => {
  await closeSeatChannel();

  assert.equal(seatChannelReady(), false);
});
