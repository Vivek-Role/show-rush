import { randomBytes } from 'node:crypto';
import { assertBookingConfig, config } from '../config/env.js';
import { pool } from '../db/pool.js';
import { HttpError } from '../lib/http-error.js';
import { getSeatStatus } from './availabilityService.js';
import { getShowWithScreen, isId } from './catalogService.js';

// Importing this module is what makes the server refuse to start with an
// unknown BOOKING_MODE, or with the racy path enabled in production.
assertBookingConfig();

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
async function assertSeatsAvailable(showId, seatIds) {
  const seats = await getSeatStatus(showId);
  const status = new Map(seats.map((seat) => [seat.id, seat.status]));

  if (seatIds.some((id) => status.get(id) !== 'available')) {
    throw new HttpError(
      409,
      'SEATS_UNAVAILABLE',
      'One or more of those seats are no longer available',
    );
  }
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

export async function createBooking({ userId, showId, seatIds }) {
  // Module 2.4 implements this branch, together with the unique constraint that
  // makes it safe. A "safe" path without that constraint would be a false
  // claim, so until then it says so plainly.
  if (config.bookingMode === 'safe') {
    throw new HttpError(
      501,
      'NOT_IMPLEMENTED',
      'Safe booking mode is not implemented yet; it arrives in Module 2.4',
    );
  }

  await recordIsolation();

  const found = await getShowWithScreen(showId);
  if (!found) {
    throw new HttpError(404, 'NOT_FOUND', 'Show not found');
  }

  const seats = await resolveSeats(found.show.id, found.screen.id, seatIds);
  const totalPaise = seats.reduce((sum, seat) => sum + seat.price_paise, 0);

  await assertSeatsAvailable(found.show.id, seatIds);

  const booking = await createBookingNaive({
    userId,
    showId: found.show.id,
    seats,
    totalPaise,
  });

  // status is 'pending' and stays there: Phase 5 owns the transition to 'paid'.
  return {
    booking_ref: booking.booking_ref,
    show_id: found.show.id,
    status: 'pending',
    total_paise: totalPaise,
    seats,
  };
}
