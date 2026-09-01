import assert from 'node:assert/strict';
import { test } from 'node:test';

// The admission arithmetic and the degraded path, which is what can be pinned
// down without a Redis to talk to. The queueing itself is Redis state; these
// cover the rules that decide who gets in and when, plus the property that a
// missing Redis lets people through rather than shutting the door.
//
// REDIS_URL is emptied and the room configured before the modules load. dotenv
// does not override a variable already in process.env, so these win over the
// repository's .env — and nothing here opens a socket, so a Redis running on
// this machine cannot make a test pass by accident.
process.env.REDIS_URL = '';
process.env.WAITING_ROOM_SHOWS = '21, 42';
process.env.WAITING_ROOM_RATE_PER_MINUTE = '60';
process.env.WAITING_ROOM_INITIAL_ADMIT = '10';

const {
  admittedBy,
  etaSeconds,
  joinQueue,
  positionOf,
  requireAdmission,
  ticketStatus,
  waitingRoomEnabled,
} = await import('./waitingRoomService.js');

test('the room is on only for the shows named in config', () => {
  assert.equal(waitingRoomEnabled('21'), true);
  assert.equal(waitingRoomEnabled(21), true, 'a numeric id is the same show');
  assert.equal(waitingRoomEnabled('42'), true, 'whitespace in the list is trimmed');
  assert.equal(waitingRoomEnabled('1'), false);
});

test('the initial allowance is admitted the instant a queue opens', () => {
  const startedAtMs = 1_000_000;
  assert.equal(admittedBy({ startedAtMs, nowMs: startedAtMs, ratePerMinute: 60, initialAdmit: 10 }), 10);
});

test('admissions accrue at the configured rate', () => {
  const startedAtMs = 1_000_000;
  const at = (ms) => admittedBy({ startedAtMs, nowMs: startedAtMs + ms, ratePerMinute: 60, initialAdmit: 0 });

  assert.equal(at(0), 0);
  assert.equal(at(1000), 1, 'one per second at 60/min');
  assert.equal(at(30_000), 30);
  assert.equal(at(60_000), 60, 'a full minute is one full rate');
  assert.equal(at(120_000), 120);
});

test('admissions floor rather than round, so nobody is admitted early', () => {
  const startedAtMs = 0;
  assert.equal(admittedBy({ startedAtMs, nowMs: 999, ratePerMinute: 60, initialAdmit: 0 }), 0);
  assert.equal(admittedBy({ startedAtMs, nowMs: 1999, ratePerMinute: 60, initialAdmit: 0 }), 1);
});

test('a clock that goes backwards cannot un-admit anyone', () => {
  // Not a hypothetical across instances: the elapsed term is clamped at zero,
  // so the worst a skewed clock does is hold admissions steady.
  assert.equal(
    admittedBy({ startedAtMs: 1_000_000, nowMs: 900_000, ratePerMinute: 60, initialAdmit: 5 }),
    5,
  );
});

test('position counts places ahead, and zero means admitted', () => {
  assert.equal(positionOf(1, 0), 1);
  assert.equal(positionOf(1, 1), 0, 'ticket 1 is in once one admission is granted');
  assert.equal(positionOf(100, 40), 60);
  assert.equal(positionOf(5, 500), 0, 'never negative');
});

test('the eta follows the position and the rate', () => {
  assert.equal(etaSeconds(0, 60), 0, 'admitted is no wait');
  assert.equal(etaSeconds(60, 60), 60);
  assert.equal(etaSeconds(30, 60), 30);
  assert.equal(etaSeconds(1, 60), 1);
  assert.equal(etaSeconds(1, 7), 9, 'rounded up — finishing early is the better surprise');
  assert.equal(etaSeconds(10, 0), null, 'a rate of zero admits nobody, so there is no estimate');
});

test('without Redis the room admits rather than shutting the door', async () => {
  // Fails open on purpose: the room is a capacity control, and holds already
  // fail closed on their own if Redis is gone. A broken throttle must not
  // become a broken checkout.
  const joined = await joinQueue({ showId: '21' });

  assert.equal(joined.admitted, true);
  assert.equal(joined.position, 0);
  assert.ok(joined.token, 'still issues a token so the client has something to carry');
});

test('a ticket status without Redis reports admitted', async () => {
  const status = await ticketStatus({ showId: '21', token: 'anything' });

  assert.equal(status.admitted, true);
  assert.equal(status.position, 0);
});

test('requireAdmission is a no-op for a show with no room', async () => {
  await requireAdmission({ showId: '1', token: null });
});

test('requireAdmission does not refuse when the room cannot be reached', async () => {
  // Redis is absent here, so ticketStatus reports admitted and this must pass.
  await requireAdmission({ showId: '21', token: null });
});
