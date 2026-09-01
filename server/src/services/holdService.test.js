import assert from 'node:assert/strict';
import { test } from 'node:test';

// BACKLOG.md P2, partial-hold handling. What can be pinned down without a Redis
// to talk to: the remainder decision, and that the owner-index read degrades to
// "nothing held" rather than throwing — because it runs after a booking that has
// already committed and must never be able to fail it.
//
// The release itself is Redis state and is covered by the local end-to-end run
// recorded with this work, not here.
//
// REDIS_URL is emptied before the module loads. dotenv does not override a
// variable already in process.env, so this wins over the repository's .env and
// nothing here can open a socket.
process.env.REDIS_URL = '';

const { heldSeatIdsFor, releaseHoldsTogether, remainderOf } = await import('./holdService.js');

test('the remainder is what was held and not booked', () => {
  // The backlog's own example: hold six, book four, two go back.
  const held = ['1', '2', '3', '4', '5', '6'];
  const booked = ['2', '3', '4', '5'];

  assert.deepEqual(remainderOf(held, booked), ['1', '6']);
});

test('booking everything held leaves no remainder', () => {
  assert.deepEqual(remainderOf(['1', '2'], ['1', '2']), []);
});

test('holding nothing leaves no remainder', () => {
  assert.deepEqual(remainderOf([], ['1', '2']), []);
});

test('booking a seat that was never held changes nothing', () => {
  // Booking without holding first is allowed — the constraint is what protects
  // the seat, not the hold. The remainder must still be only what was held.
  assert.deepEqual(remainderOf(['1'], ['9']), ['1']);
});

test('ids are compared as strings, so 10 and 2 never collide', () => {
  const held = ['2', '10'];
  assert.deepEqual(remainderOf(held, ['10']), ['2']);
  assert.deepEqual(remainderOf(held, ['2']), ['10']);
});

test('numeric and string ids match each other', () => {
  // The owner index returns strings; a caller may hand over numbers.
  assert.deepEqual(remainderOf([1, 2, 3], [2]), ['1', '3']);
});

test('a duplicated held seat is reported once', () => {
  assert.deepEqual(remainderOf(['4', '4', '5'], []), ['4', '5']);
});

test('without Redis the owner index reports nothing held', async () => {
  // Degrades rather than throws: this runs after a committed booking, and a
  // Redis problem must not turn that booking into an error.
  assert.deepEqual(await heldSeatIdsFor({ showId: '1', userId: 7 }), []);
});

test('releasing an empty remainder is a no-op and needs no Redis', async () => {
  assert.deepEqual(await releaseHoldsTogether({ showId: '1', seatIds: [], userId: 7 }), {
    releasedSeatIds: [],
  });
});
