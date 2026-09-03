import { randomBytes } from 'node:crypto';
import { assertBookingConfig, assertCancellationConfig, config } from '../config/env.js';
import { pool } from '../db/pool.js';
import { HttpError } from '../lib/http-error.js';
import { broadcastSeats } from '../realtime/hub.js';
import { getSeatStatus } from './availabilityService.js';
import { cancellationRefusal, statusAfterCancellation } from './cancellationPolicy.js';
import { getShowWithScreen, isId } from './catalogService.js';
import { describeOrphans, orphansCreatedBy } from './groupBookingRules.js';
import { heldSeatIdsFor, releaseHoldsTogether, remainderOf } from './holdService.js';

// Importing this module is what makes the server refuse to start with an
// unknown BOOKING_MODE, or with the racy path enabled in production.
assertBookingConfig();

// And with a cancellation window that cannot be parsed. Same posture, same
// reason: a value that decides whether seats can be given back is not something
// to discover is malformed on the first cancellation.
assertCancellationConfig();

// Recorded at boot so a measured run can never be attributed to the wrong mode.
console.log(`booking mode: ${config.bookingMode}`);

// Crockford base32 — no I, L, O or U, so a reference read aloud is unambiguous.
// 256 is a multiple of 32, so byte % 32 is uniform and needs no rejection
// sampling. Ten characters is 50 bits; bookings.booking_ref is UNIQUE, and a
// collision is retried rather than trusted not to happen.
const REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function newBookingRef() {
  let ref = '';
  for (const byte of randomBytes(10)) ref += REF_ALPHABET[byte % 32];
  return `SR-${ref}`;
}

// PLAN.md 2.1 requires the isolation level to be asserted at runtime rather
// than assumed: the whole before/after measurement only means something
// alongside the level it was taken at. Read once, on the first booking.
let observedIsolation = null;

async function recordIsolation() {
  if (observedIsolation) return observedIsolation;

  const { rows } = await pool.query('show transaction_isolation');
  observedIsolation = rows[0].transaction_isolation;
  console.log(`transaction isolation: ${observedIsolation}`);

  return observedIsolation;
}

export function getObservedIsolation() {
  return observedIsolation;
}

// show_prices is joined outer deliberately: a tier with no price row is a data
// fault, not a seat that does not exist, and the two need different answers.
const SEATS_FOR_BOOKING = `
  select s.id, s.row_label, s.seat_number, s.tier, p.price_paise
  from seats s
  left join show_prices p on p.show_id = $2 and p.tier = s.tier
  where s.screen_id = $1 and s.id = any($3::bigint[])
  order by s.row_label, s.seat_number
`;

async function resolveSeats(showId, screenId, seatIds) {
  // A malformed id would make Postgres raise on the bigint cast instead of
  // simply not matching. Phase 1 treats that as "no such row", and so does this.
  if (!seatIds.every(isId)) {
    throw new HttpError(404, 'NOT_FOUND', 'Seat not found for this show');
  }

  const { rows } = await pool.query(SEATS_FOR_BOOKING, [screenId, showId, seatIds]);

  // Every requested seat must exist on the screen this show runs in. A seat
  // belonging to another screen is not unavailable — it is not a seat of this
  // show at all, so it is a 404 rather than a 409.
  if (rows.length !== seatIds.length) {
    throw new HttpError(404, 'NOT_FOUND', 'Seat not found for this show');
  }

  // Fail closed. Booking at an unknown price would be worse than a 500.
  if (rows.some((row) => row.price_paise === null)) {
    throw new Error(`Show ${showId} has no price for a requested tier`);
  }

  return rows.map((row) => ({
    id: String(row.id),
    row_label: row.row_label,
    seat_number: row.seat_number,
    tier: row.tier,
    price_paise: row.price_paise,
  }));
}

// availabilityService owns seat-status truth (Phase 1 D4, PLAN.md 4.3). This is
// the only availability read on the booking path — no second query path.
//
// The booking user is passed through from Module 4.3 onward so that their own
// hold does not refuse their own booking. Seats held by anybody else are not
// available to them, which is the whole point of a hold.
// Returns the seats it read, so the group-booking rule below can reuse them.
// One availability read on the booking path, still — adding a second call for
// the rule would be the second query path CLAUDE.md §10 exists to prevent.
async function assertSeatsAvailable(showId, seatIds, userId) {
  const seats = await getSeatStatus(showId, { forUserId: userId });
  const status = new Map(seats.map((seat) => [seat.id, seat.status]));

  if (seatIds.some((id) => status.get(id) !== 'available')) {
    throw new HttpError(
      409,
      'SEATS_UNAVAILABLE',
      'One or more of those seats are no longer available',
    );
  }

  return seats;
}

// BACKLOG.md P2 — refuse a booking that would strand a single seat between two
// taken ones. Off unless GROUP_BOOKING_RULE says otherwise.
//
// Advisory, not a guarantee. Two bookings committing at the same instant each
// see the seating as it was before the other, so a pair of individually clean
// bookings can still leave an orphan between them. Closing that would mean
// locking the row for the length of the transaction, which would trade a real
// concurrency property for a seating preference — a bad bargain, and not what
// the backlog asks for. The unique constraint remains the only guarantee here.
function assertNoOrphanSeats(seats, seatIds) {
  if (config.groupBookingRule !== 'no-orphans') return;

  const orphans = orphansCreatedBy(seats, seatIds);
  if (orphans.length === 0) return;

  throw new HttpError(
    409,
    'ORPHAN_SEAT',
    `That selection would leave ${describeOrphans(seats, orphans)} stranded on its own. ` +
      'Please choose seats that do not leave a single gap.',
  );
}

async function insertBooking(userId, showId, totalPaise) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { rows } = await pool.query(
        `insert into bookings (booking_ref, user_id, show_id, status, total_paise)
         values ($1, $2, $3, 'pending', $4)
         returning id, booking_ref`,
        [newBookingRef(), userId, showId, totalPaise],
      );
      return rows[0];
    } catch (err) {
      // booking_ref is the only unique constraint this path can violate:
      // booking_seats deliberately has none until Phase 2.4. Classifying by
      // constraint name rather than by code alone keeps that true once it does.
      const refCollision = err.code === '23505' && err.constraint === 'bookings_booking_ref_key';
      if (!refCollision || attempt > 0) throw err;
    }
  }

  throw new Error('Could not generate a unique booking_ref');
}

// ---------------------------------------------------------------------------
// The naive path — PLAN.md 2.1, CLAUDE.md §10. PROTECTED DEFECT.
//
// There is no transaction here, and that is the point. The availability check
// in createBooking() is a plain SELECT that takes no locks; under READ
// COMMITTED two concurrent requests both see the seat free, neither sees the
// other's uncommitted INSERT, and booking_seats has no UNIQUE (show_id, seat_id)
// to reject the loser. Both bookings succeed and the seat is sold twice.
//
// That double-booking is the "before" number in Phase 2's before/after
// measurement, which PLAN.md names as one of two non-negotiables in the build.
//
// Do NOT add to this path: a transaction, ON CONFLICT, SELECT ... FOR UPDATE,
// an advisory lock, INSERT ... WHERE NOT EXISTS, a serialisable isolation
// level, or a retry loop. Phase 2.4 owns the fix and adds it as a separate,
// switchable path. Fixing this one destroys the measurement permanently, and
// it cannot be recovered by re-running anything.
// ---------------------------------------------------------------------------
async function createBookingNaive({ userId, showId, seats, totalPaise }) {
  // Two separate statements, two separate pool checkouts, no transaction.
  const booking = await insertBooking(userId, showId, totalPaise);

  await pool.query(
    `insert into booking_seats (booking_id, show_id, seat_id)
     select $1, $2, * from unnest($3::bigint[])`,
    [booking.id, showId, seats.map((seat) => seat.id)],
  );

  return booking;
}

// ---------------------------------------------------------------------------
// The safe path — PLAN.md 2.4.
//
// The guarantee is the unique constraint in 002_unique_booking_seats.sql, and
// nothing else. The pre-check in createBooking() is UX: it turns the ordinary
// "someone took that seat a minute ago" case into a 409 without writing a row.
// Delete the pre-check and this path is still correct — slower and ruder, but
// correct. Delete the constraint and no amount of application code makes it so.
//
// The transaction is what makes a multi-seat booking all-or-nothing: either
// every seat is claimed or none is, never a booking holding half its seats.
// ---------------------------------------------------------------------------
const SEAT_TAKEN_CONSTRAINT = 'booking_seats_show_id_seat_id_key';

async function createBookingSafe({ userId, showId, seats, totalPaise }) {
  // Two attempts, for one reason only: a booking_ref collision. Inside a
  // transaction a failed INSERT aborts the whole transaction, so the retry has
  // to be the whole transaction, not the statement. A seat conflict is never
  // retried — the seat is gone, and trying again would only take longer to say
  // so.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const client = await pool.connect();

    try {
      await client.query('begin');

      const { rows } = await client.query(
        `insert into bookings (booking_ref, user_id, show_id, status, total_paise)
         values ($1, $2, $3, 'pending', $4)
         returning id, booking_ref`,
        [newBookingRef(), userId, showId, totalPaise],
      );
      const booking = rows[0];

      // Ascending, always. Two overlapping transactions then take the index
      // entries in the same order, so one waits for the other instead of the
      // two deadlocking on seats claimed in opposite orders.
      const seatIds = seats
        .map((seat) => seat.id)
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));

      // One statement for every seat. show_id comes from the same resolved
      // show as bookings.show_id above, inside this transaction, so the two
      // columns cannot disagree — closing the denormalisation risk Phase 1
      // recorded as R2.
      await client.query(
        `insert into booking_seats (booking_id, show_id, seat_id)
         select $1, $2, * from unnest($3::bigint[])`,
        [booking.id, showId, seatIds],
      );

      await client.query('commit');
      return booking;
    } catch (err) {
      await client.query('rollback').catch(() => {});

      // Classified by constraint name, not by code alone: 23505 is also what a
      // booking_ref collision raises, and that is a retry, not a 409.
      if (err.code === '23505' && err.constraint === SEAT_TAKEN_CONSTRAINT) {
        throw new HttpError(
          409,
          'SEATS_UNAVAILABLE',
          'One or more of those seats are no longer available',
        );
      }

      if (err.code === '23505' && err.constraint === 'bookings_booking_ref_key' && attempt === 0) {
        continue;
      }

      // Sorted inserts should make this unreachable. If it ever fires, the
      // ordering assumption is wrong and that is worth knowing, so it is
      // logged rather than quietly folded into the 409 it returns.
      if (err.code === '40P01') {
        console.error('deadlock on the booking path (40P01) — seat ordering assumption may be wrong');
        throw new HttpError(
          409,
          'SEATS_UNAVAILABLE',
          'One or more of those seats are no longer available',
        );
      }

      throw err;
    } finally {
      client.release();
    }
  }

  throw new Error('Could not generate a unique booking_ref');
}

export async function createBooking({ userId, showId, seatIds }) {
  await recordIsolation();

  const found = await getShowWithScreen(showId);
  if (!found) {
    throw new HttpError(404, 'NOT_FOUND', 'Show not found');
  }

  const seats = await resolveSeats(found.show.id, found.screen.id, seatIds);
  const totalPaise = seats.reduce((sum, seat) => sum + seat.price_paise, 0);

  // Both modes run this. On the naive path it is the whole of the "check", and
  // it is why that path races. On the safe path it is UX only — see
  // createBookingSafe. Either way it returns the same 409 code the constraint
  // violation does, so a client never has to know which layer caught it.
  const showSeats = await assertSeatsAvailable(found.show.id, seatIds, userId);

  // Checked before anything is written, so a refused selection costs a read and
  // nothing else.
  assertNoOrphanSeats(showSeats, seatIds);

  const create = config.bookingMode === 'safe' ? createBookingSafe : createBookingNaive;

  const booking = await create({
    userId,
    showId: found.show.id,
    seats,
    totalPaise,
  });

  // Module 6.3. The seats are claimed in Postgres by now — both paths commit
  // before returning — so what the room is told is already true. Never awaited:
  // a booking that succeeded must not fail because a socket did.
  //
  // This is on the naive path too, and deliberately changes nothing about it:
  // it runs after createBookingNaive has returned, adds no transaction, no
  // lock and no check, and the race it is measured for is untouched.
  void broadcastSeats(found.show.id, seatIds);

  // BACKLOG.md P2 — partial-hold handling.
  //
  // Hold six, book four, and the other two were held until their TTL ran out:
  // seven minutes of seats nobody could select and nobody was going to buy.
  // The remainder is known the moment the booking commits, so it goes back now.
  //
  // Never awaited and never able to fail the booking: the seats are sold, and a
  // Redis problem is not a reason to turn a committed booking into an error.
  void releaseRemainingHolds({ showId: found.show.id, bookedSeatIds: seatIds, userId });

  // status is 'pending' and stays there: Phase 5 owns the transition to 'paid'.
  return {
    booking_ref: booking.booking_ref,
    show_id: found.show.id,
    status: 'pending',
    total_paise: totalPaise,
    seats,
  };
}

/**
 * BACKLOG.md P2 — give back the seats this user held but did not book.
 *
 * The remainder is computed from the owner hint in holdService and released as
 * one atomic Redis operation, so a part-booked selection cannot leave half its
 * leftovers held. Every step is ownership-checked against the real hold keys,
 * so a seat that expired or changed hands in the meantime is skipped rather
 * than taken from whoever has it now.
 *
 * The room is told, because those seats just became selectable again and the
 * map would otherwise show them as held until the next refetch.
 *
 * THE HONEST LIMIT: this is not atomic with the Postgres booking. It runs after
 * the booking commits, and if Redis is unreachable at that moment the remainder
 * stays held until HOLD_TTL_SECONDS — the same bound acquireHolds' rollback
 * already lives with. What it removes is the *routine* seven-minute leak, not
 * every possible one.
 */
async function releaseRemainingHolds({ showId, bookedSeatIds, userId }) {
  try {
    const held = await heldSeatIdsFor({ showId, userId });
    const remainder = remainderOf(held, bookedSeatIds);

    if (remainder.length === 0) return;

    const { releasedSeatIds } = await releaseHoldsTogether({
      showId,
      seatIds: remainder,
      userId,
    });

    if (releasedSeatIds.length > 0) void broadcastSeats(showId, releasedSeatIds);
  } catch (err) {
    // Bounded by the TTL, and never the caller's problem: the booking is done.
    console.error(`releasing the unbooked remainder failed for show ${showId}`, err);
  }
}

// ---------------------------------------------------------------------------
// Cancellation + refund flow — BACKLOG.md P2.
//
// The user-initiated counterpart to Module 6.2's sweep, and deliberately the
// same four steps in the same order: archive the seat rows, delete them, move
// the booking's status, commit. reconcileService.expireBooking does this because
// nobody paid; this does it because the person who booked asked.
//
// THE SQL BELOW IS DUPLICATED FROM reconcileService, ON PURPOSE. The two differ
// in who may trigger them, which statuses they accept, which lock they take and
// which reason they archive under, and folding them together would produce one
// function with three flags controlling behaviour that must never be confused —
// a sweep that could cancel a paid booking is a bug with a refund attached.
// Reads the same, stays separate. If either changes shape, change both:
// reconcileService.js ARCHIVE / DROP_SEATS / CANCEL are the other copy.
//
// WHAT THIS DOES NOT DO: charge anybody back. See cancellationPolicy.js.
// ---------------------------------------------------------------------------

// Identity only: does this reference exist, and whose is it. Read outside any
// transaction so 404 and 403 are answered without taking a lock, and
// deliberately without starts_at — the policy is checked against the locked row
// below, never against this one.
const BOOKING_FOR_CANCEL = `
  select b.id, b.booking_ref, b.user_id, b.show_id, b.status, b.total_paise
    from bookings b
   where b.booking_ref = $1
`;

// FOR UPDATE OF b, not a bare FOR UPDATE: the join is only there for starts_at
// and locking the shows row as well would make two people cancelling different
// bookings for the same show queue behind each other for nothing.
//
// This is the same row paymentService.LOCK_BOOKING takes and the same row
// reconcileService.LOCK_ONE takes, which is the whole concurrency story: a
// cancellation, a payment and a sweep for one booking serialise on it, and
// whichever commits first is read as committed by the others.
const LOCK_BOOKING_FOR_CANCEL = `
  select b.id, b.booking_ref, b.show_id, b.status, b.total_paise, sh.starts_at
    from bookings b
    join shows sh on sh.id = b.show_id
   where b.id = $1
     for update of b
`;

// reason = 'cancelled', which is what migration 005 added. RETURNING is what
// reports the seats that came back, so the broadcast describes what actually
// changed instead of what the request asked for.
const ARCHIVE_CANCELLED = `
  insert into released_booking_seats (booking_id, show_id, seat_id, reason)
  select booking_id, show_id, seat_id, 'cancelled'
    from booking_seats
   where booking_id = $1
   order by seat_id
  returning seat_id
`;

const DROP_CANCELLED_SEATS = 'delete from booking_seats where booking_id = $1';

// Guarded on the status read under the lock. If the row somehow moved anyway
// this updates nothing, and the transaction is rolled back rather than
// cancelling a booking that has meanwhile been paid for or swept.
const CANCEL_BOOKING = `
  update bookings
     set status = $2, updated_at = now()
   where id = $1 and status = $3
  returning booking_ref, show_id, status, total_paise
`;

function cancelledBookingPayload(row) {
  return {
    booking_ref: row.booking_ref,
    show_id: String(row.show_id),
    status: row.status,
    total_paise: row.total_paise,
    // Said out loud rather than left for the caller to infer from a status:
    // 'refund_pending' means a refund is owed, and nothing in this build pays
    // one. BACKLOG.md P1 is where a real provider would come from.
    refund_due: row.status === 'refund_pending',
  };
}

/**
 * Cancel a booking and give its seats back.
 *
 * All-or-nothing: either the seats are archived, released and the status moved,
 * or nothing happened at all. The seats become available to everybody else the
 * moment this commits — availabilityService already treats a cancelled
 * booking's seats as free, and deleting the booking_seats rows is what releases
 * the Phase 2.4 unique index entry so the next person can actually take them.
 */
export async function cancelBooking({ userId, bookingRef }) {
  const { rows } = await pool.query(BOOKING_FOR_CANCEL, [bookingRef]);
  const booking = rows[0];

  if (!booking) {
    throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
  }

  // 403 rather than 404, exactly as confirmPayment answers: the reference was a
  // real reference, and "not found" would make a genuine typo indistinguishable
  // from somebody else's booking.
  if (String(booking.user_id) !== String(userId)) {
    throw new HttpError(403, 'FORBIDDEN', 'That booking belongs to another account');
  }

  const client = await pool.connect();
  let refusal = null;

  try {
    await client.query('begin');

    const locked = await client.query(LOCK_BOOKING_FOR_CANCEL, [booking.id]);
    const current = locked.rows[0];

    // Bookings are never deleted, so this is unreachable in practice. Answered
    // rather than thrown, because "the booking is gone" is a 404 whichever
    // statement discovered it.
    if (!current) {
      await client.query('rollback');
      refusal = { status: 404, code: 'NOT_FOUND', message: 'Booking not found' };
    } else {
      // The status that decides is the one read under the lock. The status from
      // the SELECT above was taken outside any transaction and may already be
      // stale — a payment or a sweep can have landed in between.
      const denied = cancellationRefusal({
        status: current.status,
        startsAtMs: current.starts_at?.getTime?.() ?? Number.NaN,
        nowMs: Date.now(),
        windowMinutes: config.cancellationWindowMinutes,
      });

      if (denied) {
        await client.query('rollback');
        refusal = { status: 409, ...denied };
      } else {
        const archived = await client.query(ARCHIVE_CANCELLED, [booking.id]);
        await client.query(DROP_CANCELLED_SEATS, [booking.id]);

        const updated = await client.query(CANCEL_BOOKING, [
          booking.id,
          statusAfterCancellation(current.status),
          current.status,
        ]);

        // Unreachable behind the locked SELECT. If it ever fires, the locking
        // assumption is wrong and that is worth knowing, so nothing is written.
        if (updated.rowCount === 0) {
          await client.query('rollback');
          console.error(`cancel: booking ${booking.booking_ref} changed under its own lock`);
          throw new Error(`Booking ${booking.booking_ref} changed under its own lock`);
        }

        await client.query('commit');

        const seatIds = archived.rows.map((row) => String(row.seat_id));
        const showId = String(current.show_id);

        // After the commit, and never awaited: the seats are free in Postgres
        // by now, so what the room is told is already true, and a cancellation
        // that succeeded must not report failure because a socket did.
        void broadcastSeats(showId, seatIds);

        return cancelledBookingPayload(updated.rows[0]);
      }
    }
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Thrown outside the try so the rollback above is the only one that runs —
  // the same shape recordPayment uses for its conflict.
  throw new HttpError(refusal.status, refusal.code, refusal.message);
}
