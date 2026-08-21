import { Router } from 'express';
import { HttpError } from '../lib/http-error.js';
import { bookingRef, eventId, validationError } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import {
  MAX_SIMULATED_DELAY_MS,
  confirmPayment,
  simulationAllowed,
} from '../services/paymentService.js';

// Phase 5.3. One endpoint: a provider event arrives, the booking it names
// becomes paid, and it does so exactly once however many times the event is
// replayed.
//
// This is a *user-confirmed* mock payment, not a provider webhook: it carries
// the payer's own session rather than a signature. A real gateway is
// BACKLOG.md P1, and the idempotency layer underneath is indifferent to which
// of the two calls it — which is the point of testing it now.
export const paymentsRouter = Router();

// The mock's controls, and the only part of the body that is not the payment
// itself. Absent is the normal case; present in production is a 400, before
// the provider is ever reached.
function simulation(value) {
  if (value === undefined || value === null) return null;

  if (!simulationAllowed()) {
    throw validationError('simulate is not accepted in production');
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('simulate must be an object');
  }

  const outcome = value.outcome ?? 'succeeded';
  if (outcome !== 'succeeded' && outcome !== 'failed') {
    throw validationError("simulate.outcome must be 'succeeded' or 'failed'");
  }

  const delayMs = value.delay_ms ?? 0;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_SIMULATED_DELAY_MS) {
    throw validationError(
      `simulate.delay_ms must be an integer between 0 and ${MAX_SIMULATED_DELAY_MS}`,
    );
  }

  return { outcome, delay_ms: delayMs };
}

paymentsRouter.post('/confirm', requireAuth, async (req, res) => {
  const body = req.body ?? {};

  const result = await confirmPayment({
    userId: req.user.id,
    bookingRef: bookingRef(body.booking_ref),
    eventId: eventId(body.payment_event_id),
    simulate: simulation(body.simulate),
  });

  // A failed charge is a recorded event with an unhappy answer, not a server
  // fault. 402 is the one status that says "the payment did not go through"
  // without implying the request was malformed or the booking is gone. The
  // seats stay the caller's: the booking is untouched and still pending.
  //
  // A replay of a failed event lands here too, answered from the stored row —
  // the provider is not run a second time and nothing is written.
  if (result.payment.status === 'failed') {
    throw new HttpError(402, 'PAYMENT_FAILED', 'The payment did not go through');
  }

  // 201 the first time, 200 for a replay — PLAN.md 5.2 fixes the duplicate at
  // 200 with the original booking, never a 409. The status code is also what
  // the k6 replay counters read, so "exactly one created" is countable without
  // parsing a body.
  res.status(result.duplicate ? 200 : 201).json({
    payment: result.payment,
    booking: result.booking,
  });
});
