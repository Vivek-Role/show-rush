// BACKLOG.md P2 — cancellation + refund flow: the policy, and only the policy.
//
// Pure. No Postgres, no Redis, no HTTP, no clock of its own — it takes four
// values and answers one question. That is what lets every branch be tested
// without a database, and it is what keeps the answer from drifting away from
// what the transaction enforces: bookingService does not re-implement this rule,
// it calls this function with the row it has already locked.
//
// THE RULE, STATED EXACTLY. A booking may be cancelled when
//
//   1. its status is 'pending' or 'paid', and
//   2. the show it is for starts more than CANCELLATION_WINDOW_MINUTES from now.
//
// WHAT IS DELIBERATELY NOT PART OF THE RULE:
//
//   - Who paid, and how much. A refund is owed or it is not; the amount is
//     already on the booking and nothing here recomputes it.
//   - Partial cancellation. A booking is cancelled whole. Giving back three of
//     six seats is a different feature, is not what the backlog line asks for,
//     and would need its own decision about what the remaining booking costs.
//   - Any charge-back. See below.
//
// A CANCELLATION DOES NOT REFUND ANYONE. There is no payment provider in this
// build — a real gateway is BACKLOG.md P1 and is deliberately not implemented —
// so cancelling a paid booking marks it 'refund_pending' and that is the whole
// of it. It is a record that a refund is owed, never evidence that one happened.

// 'cancelled' and 'refund_pending' are already terminal: the first has given its
// seats back and the second has given them back and owes money. Neither has
// anything left to cancel, so both are refused rather than repeated.
const CANCELLABLE = new Set(['pending', 'paid']);

const MINUTE_MS = 60000;

/**
 * Why this booking may not be cancelled, or null when it may be.
 *
 * A refusal, not a boolean, because the two reasons need different words: "you
 * already cancelled this" and "it is too late" are not the same news, and a
 * caller that could only see `false` would have to guess which to say.
 *
 * @param {object} args
 * @param {string} args.status         bookings.status, as read under the lock
 * @param {number} args.startsAtMs     shows.starts_at, in epoch milliseconds
 * @param {number} args.nowMs          the caller's clock, passed in so it is testable
 * @param {number} args.windowMinutes  CANCELLATION_WINDOW_MINUTES
 * @returns {{code: string, message: string} | null}
 */
export function cancellationRefusal({ status, startsAtMs, nowMs, windowMinutes }) {
  if (!CANCELLABLE.has(status)) {
    return {
      code: 'NOT_CANCELLABLE',
      message: `That booking is ${status}, so there is nothing left to cancel`,
    };
  }

  // Fail closed on a showtime that cannot be read. shows.starts_at is NOT NULL
  // and every caller joins it, so this is a backstop rather than an expected
  // path — the same posture holdService.assertIds takes against ids the routes
  // have already validated. Allowing a cancellation because the deadline could
  // not be established would be the one direction that cannot be undone.
  if (!Number.isFinite(startsAtMs) || !Number.isFinite(nowMs)) {
    return {
      code: 'NOT_CANCELLABLE',
      message: 'That booking cannot be cancelled',
    };
  }

  // <= and not <: exactly on the boundary is closed. A cut-off that lets the
  // final millisecond through is a cut-off nobody can state out loud, and
  // "cancel up to two hours before" reads as two hours, not two hours and one
  // instant. windowMinutes = 0 therefore still allows cancellation until the
  // moment the show starts, and refuses it once it has.
  if (startsAtMs - nowMs <= windowMinutes * MINUTE_MS) {
    return {
      code: 'CANCELLATION_WINDOW_CLOSED',
      message:
        windowMinutes === 0
          ? 'That show has already started, so the booking can no longer be cancelled'
          : `Bookings can only be cancelled more than ${windowMinutes} minutes before the show starts`,
    };
  }

  return null;
}

/**
 * What a cancelled booking becomes.
 *
 * 'pending' was never paid, so it is simply cancelled. 'paid' owes the payer
 * their money back, and 'refund_pending' is the status that already means
 * exactly that — Module 6.1 writes it when a late payment lands on seats
 * somebody else has taken.
 *
 * THE HONEST AMBIGUITY: after this change 'refund_pending' has two causes — the
 * system lost your seats, and you asked to cancel. They are told apart by
 * released_booking_seats.reason ('expired' vs 'cancelled') and by whether a
 * payment_events row exists at all, not by the status alone. Reusing the status
 * was chosen over adding a fourth one so that the bookings CHECK constraint and
 * every query that branches on status stay as they are; the cost is written
 * here rather than discovered later.
 */
export function statusAfterCancellation(status) {
  return status === 'paid' ? 'refund_pending' : 'cancelled';
}
