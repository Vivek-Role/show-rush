import { assertReconcileConfig, config } from '../config/env.js';
import { pool } from '../db/pool.js';
import { broadcastSeats } from '../realtime/hub.js';
import { HOLD_TTL_SECONDS } from './holdService.js';

// Phase 6.2 — the periodic sweep.
//
// Phase 5 left unpaid bookings claiming their seats forever
// (docs/phases/phase-5-payments.md §8). This is what finishes them: a booking
// that has sat 'pending' past its window is cancelled and its seats go back on
// the map.
//
// Giving a seat back is not just a status change. Phase 2.4's
// booking_seats_show_id_seat_id_key is an unconditional UNIQUE (show_id,
// seat_id), while availabilityService treats a cancelled booking's seats as
// free. Leaving the rows in place would produce a seat that reads 'available'
// and still raises 23505 on re-booking. So the rows are archived into
// released_booking_seats and deleted, which releases the constraint entry and
// keeps the seat list Module 6.1 re-claims from. Migration 002 is untouched.
//
// The Redis half of PLAN.md 6.2 — "held-but-abandoned" — is deliberately a
// no-op, and that is a decision rather than an omission. A hold is one key with
// an EX and nothing else (holdService.js): Redis expires it without help. A
// sweep would have to SCAN the keyspace, which is exactly the second
// seat-status path CLAUDE.md §10 forbids. An orphan hold on a seat that is
// already sold is harmless and gone within HOLD_TTL_SECONDS.

// Shape first: a malformed interval or window is a refusal to start, not a
// default quietly substituted at the moment the sweep would have run.
assertReconcileConfig();

// A booking must not be able to expire while its own hold is still alive —
// that would invert the lifecycle, cancelling a booking the user is still
// actively working on. Checked at import, so a misconfigured server refuses to
// start rather than discovering it during a sweep. The same posture
// assertBookingConfig() takes for BOOKING_MODE.
if (config.pendingBookingTtlSeconds <= HOLD_TTL_SECONDS) {
  throw new Error(
    `PENDING_BOOKING_TTL_SECONDS (${config.pendingBookingTtlSeconds}) must exceed the ` +
      `${HOLD_TTL_SECONDS}s hold TTL, or a booking could expire while its hold is still live. ` +
      'See .env.example.',
  );
}

// One run touches at most this many bookings. A sweep is background work: it
// must never occupy the connection pool long enough to matter to a request,
// and whatever it does not reach this minute it reaches the next.
export const RECONCILE_BATCH_LIMIT = 200;

// No lock here. This only nominates candidates; the transaction below re-checks
// every one of them under a lock, because between this statement and that one a
// booking can be paid.
const CANDIDATES = `
  select id
    from bookings
   where status = 'pending'
     and created_at < now() - ($1::int * interval '1 second')
   order by id
   limit $2
`;

// The lock, and the whole of the concurrency story.
//
// SKIP LOCKED is what makes two overlapping sweeps safe: the second run does
// not block on a row the first is already cancelling, it simply leaves it
// alone. status = 'pending' repeated here is what makes the sweep safe against
// a payment — paymentService takes FOR UPDATE on this same row, so whichever
// transaction commits first wins and the other reads the committed result.
const LOCK_ONE = `
  select id, show_id
    from bookings
   where id = $1 and status = 'pending'
     for update skip locked
`;

// RETURNING is what reports which seats came back, so a caller can say so
// rather than counting rows a second time.
const ARCHIVE = `
  insert into released_booking_seats (booking_id, show_id, seat_id, reason)
  select booking_id, show_id, seat_id, 'expired'
    from booking_seats
   where booking_id = $1
  returning seat_id
`;

const DROP_SEATS = 'delete from booking_seats where booking_id = $1';

// The second guard. Belt and braces with the locked SELECT above: if the row
// somehow moved on, this updates nothing and the transaction is rolled back
// rather than cancelling a booking that has been paid for.
const CANCEL = `
  update bookings
     set status = 'cancelled', updated_at = now()
   where id = $1 and status = 'pending'
`;

/**
 * Expire one booking. Everything or nothing: archive, delete, cancel, commit.
 *
 * Returns the seats released, or null when the booking was locked by someone
 * else or is no longer pending — both ordinary, neither an error.
 */
async function expireBooking(bookingId) {
  const client = await pool.connect();

  try {
    await client.query('begin');

    const locked = await client.query(LOCK_ONE, [bookingId]);
    if (locked.rowCount === 0) {
      await client.query('rollback');
      return null;
    }

    const archived = await client.query(ARCHIVE, [bookingId]);
    await client.query(DROP_SEATS, [bookingId]);

    const cancelled = await client.query(CANCEL, [bookingId]);
    if (cancelled.rowCount === 0) {
      // Unreachable behind the locked SELECT. If it ever fires, the locking
      // assumption is wrong and that is worth knowing, so nothing is written.
      await client.query('rollback');
      console.error(`reconcile: booking ${bookingId} changed under its own lock`);
      return null;
    }

    await client.query('commit');

    return {
      bookingId: String(locked.rows[0].id),
      showId: String(locked.rows[0].show_id),
      seatIds: archived.rows.map((row) => String(row.seat_id)),
    };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * One sweep. Idempotent: a booking already cancelled is never a candidate, and
 * re-running immediately writes nothing.
 *
 * Safe to overlap its own previous run — see LOCK_ONE.
 */
export async function runSweep({ limit = RECONCILE_BATCH_LIMIT } = {}) {
  if (!pool) {
    throw new Error('DATABASE_URL is not set');
  }

  const { rows } = await pool.query(CANDIDATES, [config.pendingBookingTtlSeconds, limit]);

  const expired = [];
  let seatsReleased = 0;

  for (const row of rows) {
    const result = await expireBooking(row.id);
    if (!result) continue;

    expired.push(result);
    seatsReleased += result.seatIds.length;

    // Module 6.3. After the commit, never awaited: a sweep that succeeded must
    // not report failure because a socket did. The seats are read back by
    // availabilityService inside broadcastSeats, not asserted here — this
    // function knows the booking let them go, not what they are now.
    //
    // From `npm run reconcile` there is no socket server in the process, so
    // this finds no room and returns immediately. Harmless by construction.
    void broadcastSeats(result.showId, result.seatIds);
  }

  return { scanned: rows.length, cancelled: expired.length, seatsReleased, expired };
}

// ---------------------------------------------------------------------------
// The schedule.
// ---------------------------------------------------------------------------

let timer = null;
let running = false;

/**
 * A single in-flight flag, not a queue. If one sweep is still going when the
 * next tick arrives, the tick is dropped: the work is idempotent and the
 * candidates will still be candidates a minute later. Overlapping runs are
 * safe, but there is no reason to create them on purpose.
 */
async function tick() {
  if (running) return;
  running = true;

  try {
    const result = await runSweep();
    if (result.cancelled > 0) {
      console.log(
        `reconcile: ${result.cancelled} booking(s) expired, ${result.seatsReleased} seat(s) released`,
      );
    }
  } catch (err) {
    // A failed sweep must never take the server down. The next tick retries.
    console.error('reconcile: sweep failed', err);
  } finally {
    running = false;
  }
}

export function startReconcileLoop() {
  if (timer) return;

  // 0 disables the loop entirely while leaving `npm run reconcile` working.
  // That is how a benchmark guarantees nothing mutated bookings underneath it.
  if (config.reconcileIntervalSeconds === 0) {
    console.log('reconcile: interval disabled (RECONCILE_INTERVAL_SECONDS=0)');
    return;
  }

  console.log(
    `reconcile: every ${config.reconcileIntervalSeconds}s, expiring pending bookings older than ${config.pendingBookingTtlSeconds}s`,
  );

  timer = setInterval(tick, config.reconcileIntervalSeconds * 1000);

  // Without this the interval alone keeps the process alive, and a server told
  // to shut down would wait out the timer.
  timer.unref?.();
}

export function stopReconcileLoop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
