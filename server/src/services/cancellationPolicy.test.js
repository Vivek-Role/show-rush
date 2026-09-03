import assert from 'node:assert/strict';
import test from 'node:test';
import { cancellationRefusal, statusAfterCancellation } from './cancellationPolicy.js';

// BACKLOG.md P2 — cancellation + refund flow.
//
// The policy is pure, so every branch is reachable without a database, a clock
// or a server. `nowMs` is passed in for exactly that reason: a test that had to
// wait for real time to pass would be a slow test that still could not reach
// the boundary case below.

const HOUR = 3600000;
const NOW = 1_800_000_000_000;

// A show comfortably in the future, and the default 120-minute window.
function refusalFor(overrides = {}) {
  return cancellationRefusal({
    status: 'pending',
    startsAtMs: NOW + 24 * HOUR,
    nowMs: NOW,
    windowMinutes: 120,
    ...overrides,
  });
}

test('a pending booking well before the show may be cancelled', () => {
  assert.equal(refusalFor(), null);
});

test('a paid booking well before the show may be cancelled', () => {
  assert.equal(refusalFor({ status: 'paid' }), null);
});

test('an already cancelled booking is refused', () => {
  const refusal = refusalFor({ status: 'cancelled' });

  assert.equal(refusal.code, 'NOT_CANCELLABLE');
  assert.match(refusal.message, /cancelled/);
});

test('a booking already owing a refund is refused', () => {
  // Module 6.1 wrote this status when a late payment landed on lost seats.
  // There is nothing left to give back, so cancelling it again is refused
  // rather than repeated.
  const refusal = refusalFor({ status: 'refund_pending' });

  assert.equal(refusal.code, 'NOT_CANCELLABLE');
});

test('an unknown status is refused rather than allowed', () => {
  // Fails closed. A status this build does not recognise is not a licence to
  // release somebody's seats.
  assert.equal(refusalFor({ status: 'something-else' }).code, 'NOT_CANCELLABLE');
});

test('inside the window the booking is refused', () => {
  const refusal = refusalFor({ startsAtMs: NOW + HOUR });

  assert.equal(refusal.code, 'CANCELLATION_WINDOW_CLOSED');
  assert.match(refusal.message, /120 minutes/);
});

test('exactly on the boundary is closed, one millisecond earlier is open', () => {
  // The rule is stated as "more than N minutes before", so the boundary itself
  // is refused. Both sides are asserted here so the direction cannot be flipped
  // by accident later.
  const onTheBoundary = refusalFor({ startsAtMs: NOW + 120 * 60000 });
  const justOutside = refusalFor({ startsAtMs: NOW + 120 * 60000 + 1 });

  assert.equal(onTheBoundary.code, 'CANCELLATION_WINDOW_CLOSED');
  assert.equal(justOutside, null);
});

test('a show that has already started is refused', () => {
  assert.equal(refusalFor({ startsAtMs: NOW - HOUR }).code, 'CANCELLATION_WINDOW_CLOSED');
});

test('a zero window allows cancellation until the show starts', () => {
  assert.equal(refusalFor({ startsAtMs: NOW + 1, windowMinutes: 0 }), null);
  assert.equal(refusalFor({ startsAtMs: NOW, windowMinutes: 0 }).code, 'CANCELLATION_WINDOW_CLOSED');
});

test('the status is checked before the window', () => {
  // A cancelled booking inside the window is told it is already cancelled, not
  // that it is too late — the more useful of the two true answers.
  const refusal = refusalFor({ status: 'cancelled', startsAtMs: NOW + 1 });

  assert.equal(refusal.code, 'NOT_CANCELLABLE');
});

test('an unreadable showtime is refused', () => {
  // shows.starts_at is NOT NULL and every caller joins it, so this is a
  // backstop. It fails closed: allowing a cancellation because the deadline
  // could not be established is the one direction that cannot be undone.
  assert.equal(refusalFor({ startsAtMs: Number.NaN }).code, 'NOT_CANCELLABLE');
  assert.equal(refusalFor({ startsAtMs: undefined }).code, 'NOT_CANCELLABLE');
  assert.equal(refusalFor({ nowMs: Number.NaN }).code, 'NOT_CANCELLABLE');
});

test('a cancelled pending booking owes nothing; a cancelled paid one owes a refund', () => {
  assert.equal(statusAfterCancellation('pending'), 'cancelled');
  assert.equal(statusAfterCancellation('paid'), 'refund_pending');
});
