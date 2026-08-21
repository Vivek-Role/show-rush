import { config } from '../config/env.js';
import { pool } from '../db/pool.js';
import { HttpError } from '../lib/http-error.js';
import { releaseHolds } from './holdService.js';

// Phase 5 — payment confirmation and its idempotency.
//
// The mock provider and the confirmation flow live in one file on purpose:
// thirty lines of fake gateway do not earn a module boundary, and keeping them
// adjacent makes the ordering rule below readable in one screen.
//
// The rule, from PLAN.md 5.3: commit Postgres first, release the Redis hold
// after. Releasing inside the transaction is a correctness bug — a rollback
// would free a seat whose payment succeeded. A hold outliving its booking is
// harmless: the seat is already sold.
//
// This module adds no availability read. A booking's seats were claimed in
// Postgres at Phase 2 time, so payment never asks whether they are free —
// availabilityService remains the only seat-status path (CLAUDE.md §10).

// ---------------------------------------------------------------------------
// 5.1 — the mock provider.
//
// PLAN.md defers Razorpay to BACKLOG.md P1: a real gateway needs ngrok and a
// public URL, and produces the identical idempotency metric. What is mocked is
// only the charge itself. The idempotency layer below is real, and it does not
// care which of the two calls it.
// ---------------------------------------------------------------------------

// Ten minutes. Comfortably covers PLAN.md 6.1's eight-minute late-payment
// injection and the 420-second hold TTL, and bounds how long one request can
// occupy a pool connection.
export const MAX_SIMULATED_DELAY_MS = 600000;

// The simulation controls are a testing affordance, not a product feature. In
// production they are refused outright — the same shape of guard
// assertBookingConfig() applies to BOOKING_MODE=naive, and for the same reason:
// a switch that changes what the system does must never be reachable by a
// request from the outside world.
export function simulationAllowed() {
  return config.nodeEnv !== 'production';
}

/**
 * Charge the mock provider. Succeeds unless told otherwise: a mock that failed
 * by default would make every manual check a two-step dance.
 *
 * The delay is spent here, before the transaction opens, because what it
 * simulates is a provider that called back late. Sleeping inside the
 * transaction would simulate a slow database instead, and hold a row lock for
 * eight minutes.
 */
export async function chargeMock({ amountPaise, simulate }) {
  const delayMs = simulate?.delay_ms ?? 0;

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return {
    outcome: simulate?.outcome ?? 'succeeded',
    amountPaise,
    delayedMs: delayMs,
  };
}

// ---------------------------------------------------------------------------
// 5.2 / 5.3 — confirmation.
// ---------------------------------------------------------------------------

const BOOKING_BY_REF = `
  select id, booking_ref, user_id, show_id, status, total_paise
  from bookings
  where booking_ref = $1
`;

// The constraint from migration 003. Classified by name, never by 23505 alone:
// bookings_booking_ref_key raises the same code and means something else
// entirely — the same discipline bookingService applies on the seat path.
const EVENT_ID_CONSTRAINT = 'payment_events_event_id_key';

function bookingPayload(row) {
  return {
    booking_ref: row.booking_ref,
    show_id: String(row.show_id),
    status: row.status,
    total_paise: row.total_paise,
  };
}

function eventPayload(row, duplicate) {
  return {
    event_id: row.event_id,
    status: row.status,
    amount_paise: row.amount_paise,
    duplicate,
  };
}

/**
 * The answer a replayed event gets: the one the original produced, read back
 * rather than recomputed.
 *
 * This runs as a fresh query on a *new* snapshot, deliberately after the
 * duplicate insert has been rolled back. Postgres blocks the second inserter on
 * the index entry until the first transaction ends, so by the time 23505 is
 * raised the winner has committed and its row is visible here. Reading inside
 * the aborted transaction would see nothing at all.
 */
async function storedEvent(eventId) {
  const { rows } = await pool.query(
    `select pe.event_id, pe.status, pe.amount_paise, pe.booking_id,
            b.booking_ref, b.show_id, b.status as booking_status, b.total_paise
       from payment_events pe
       join bookings b on b.id = pe.booking_id
      where pe.event_id = $1`,
    [eventId],
  );

  return rows[0] ?? null;
}

/**
 * One transaction: record the event, and — only for a successful charge — move
 * the booking to paid.
 *
 * The INSERT is the check. There is no SELECT beforehand asking whether this
 * event has been seen: that is the Phase 2.1 race with a different table name.
 * The unique constraint is the guarantee, exactly as it is for seats.
 */
async function recordPayment({ booking, eventId, outcome }) {
  const client = await pool.connect();
  let conflict = false;

  try {
    await client.query('begin');

    const inserted = await client.query(
      `insert into payment_events (event_id, booking_id, status, amount_paise)
       values ($1, $2, $3, $4)
       returning event_id, status, amount_paise`,
      [eventId, booking.id, outcome, booking.total_paise],
    );

    let bookingRow = booking;

    if (outcome === 'succeeded') {
      // The second guard, and the reason the status transition is idempotent
      // even if the event check were bypassed: a booking already paid by some
      // other event, or cancelled, updates nothing.
      const updated = await client.query(
        `update bookings
            set status = 'paid', updated_at = now()
          where id = $1 and status = 'pending'
          returning id, booking_ref, user_id, show_id, status, total_paise`,
        [booking.id],
      );

      if (updated.rowCount === 0) conflict = true;
      else bookingRow = updated.rows[0];
    }

    // Rolling back a conflict is what keeps a rejected event out of
    // payment_events entirely, so the table means what it says.
    if (conflict) await client.query('rollback');
    else await client.query('commit');

    if (!conflict) {
      return { duplicate: false, event: inserted.rows[0], booking: bookingRow };
    }
  } catch (err) {
    await client.query('rollback').catch(() => {});

    if (err.code === '23505' && err.constraint === EVENT_ID_CONSTRAINT) {
      return { duplicate: true, event: null, booking: null };
    }

    throw err;
  } finally {
    client.release();
  }

  // Thrown outside the try so the rollback above is the only one that runs.
  throw new HttpError(
    409,
    'BOOKING_NOT_PENDING',
    'That booking is no longer pending, so it cannot be paid for',
  );
}

/**
 * The answer to a replay, built from the stored row and nothing else. Reached
 * two ways — the pre-read in confirmPayment, and the constraint violation
 * underneath it — and it must give the same answer either way, which is why it
 * lives in one place.
 */
function replayAnswer(stored, booking) {
  // The event already did its work against a different booking. Returning the
  // stored answer would disclose that booking; re-running it would be the side
  // effect this whole layer exists to prevent.
  if (String(stored.booking_id) !== String(booking.id)) {
    throw new HttpError(
      409,
      'EVENT_ALREADY_USED',
      'That payment event id has already been used for a different booking',
    );
  }

  // Zero side effects: no charge, no UPDATE, and no Redis call.
  return {
    duplicate: true,
    payment: eventPayload(stored, true),
    booking: bookingPayload({ ...stored, status: stored.booking_status }),
  };
}

/**
 * Release the holds on a paid booking's seats. Called only after the
 * transaction has committed, and best effort in the strict sense: nothing here
 * may turn a committed payment into an error response.
 *
 * releaseHolds is compare-and-delete and owner-scoped, so a hold that already
 * expired — or that the client released when the booking was created back in
 * Phase 4 — is a no-op rather than a failure. Redis being down makes
 * holdService throw 503; that is swallowed here and the hold expires at its TTL.
 */
async function releaseBookingHolds(booking, userId) {
  try {
    const { rows } = await pool.query(
      'select seat_id from booking_seats where booking_id = $1',
      [booking.id],
    );

    if (rows.length === 0) return;

    await releaseHolds({
      showId: String(booking.show_id),
      seatIds: rows.map((row) => String(row.seat_id)),
      userId,
    });
  } catch (err) {
    console.error(`hold release after payment failed for booking ${booking.booking_ref}`, err);
  }
}

export async function confirmPayment({ userId, bookingRef, eventId, simulate }) {
  const { rows } = await pool.query(BOOKING_BY_REF, [bookingRef]);
  const booking = rows[0];

  if (!booking) {
    throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
  }

  // 403 rather than 404: the reference was a real reference, and answering
  // "not found" would make a genuine typo indistinguishable from somebody
  // else's booking. A ref is 50 bits of Crockford base32 — it is not guessed.
  if (String(booking.user_id) !== String(userId)) {
    throw new HttpError(403, 'FORBIDDEN', 'That booking belongs to another account');
  }

  // A replay must not reach the provider at all: charging again is precisely
  // the side effect this layer exists to prevent, and with a real gateway it
  // would be a second charge rather than a second mock call.
  //
  // This read is NOT the idempotency guarantee — the unique constraint below
  // is, and it is what decides when two replays arrive at once. This is the
  // same relationship the Phase 2 availability pre-check has with
  // UNIQUE (show_id, seat_id): delete it and the system is still correct, just
  // wasteful. What it removes is the wasted charge, not the race.
  const seen = await storedEvent(eventId);
  if (seen) return replayAnswer(seen, booking);

  const charge = await chargeMock({ amountPaise: booking.total_paise, simulate });
  const result = await recordPayment({ booking, eventId, outcome: charge.outcome });

  if (result.duplicate) {
    // The concurrent case: the read above found nothing, and another request
    // committed this event between then and the INSERT. The constraint caught
    // it, which is what the constraint is for.
    const stored = await storedEvent(eventId);

    // Unreachable in practice: the duplicate was raised by a committed row.
    if (!stored) {
      throw new Error(`payment event ${eventId} raised a duplicate but could not be read back`);
    }

    return replayAnswer(stored, booking);
  }

  // Committed. Only now, and never before.
  if (result.event.status === 'succeeded') {
    await releaseBookingHolds(booking, userId);
  }

  return {
    duplicate: false,
    payment: eventPayload(result.event, false),
    booking: bookingPayload(result.booking),
  };
}
