import { Router } from 'express';
import { HttpError } from '../lib/http-error.js';
import { seatIdList, validationError } from '../lib/validate.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { rateLimitHolds } from '../middleware/rateLimit.js';
import { broadcastSeats } from '../realtime/hub.js';
import { getSeatStatus } from '../services/availabilityService.js';
import { getShowWithScreen, seatIdsOnScreen } from '../services/catalogService.js';
import { acquireHolds, getHoldOwner, getHoldTtl, releaseHolds } from '../services/holdService.js';

export const showsRouter = Router();

// Public, but not anonymous when it does not have to be: optionalAuth lets the
// merge below report the viewer's own holds as available to them.
showsRouter.get('/:id/seatmap', optionalAuth, async (req, res) => {
  const found = await getShowWithScreen(req.params.id);
  if (!found) {
    throw new HttpError(404, 'NOT_FOUND', 'Show not found');
  }

  // Seat status comes from availabilityService and nowhere else.
  const seats = await getSeatStatus(found.show.id, { forUserId: req.user?.id });

  res.json({ show: found.show, screen: found.screen, seats });
});

// ---------------------------------------------------------------------------
// Holds — PLAN.md 4.2. Three endpoints over the Module 4.1 service.
//
// A hold is not a booking and confers no guarantee: the unique constraint from
// Phase 2.4 is still the only thing that makes a seat sell once. These
// endpoints stop two people spending seven minutes on the same seat.
// ---------------------------------------------------------------------------

// An unknown show is a 404 on every hold route, the same answer /seatmap gives.
async function requireShow(showId) {
  const found = await getShowWithScreen(showId);
  if (!found) {
    throw new HttpError(404, 'NOT_FOUND', 'Show not found');
  }
  return found;
}

// Seat identity is Postgres's answer, not Redis's. A seat belonging to another
// screen is not unavailable — it is not a seat of this show at all, so it is a
// 404, matching the booking path rather than inventing a second convention.
async function requireSeatsOnScreen(screenId, seatIds) {
  const known = await seatIdsOnScreen(screenId, seatIds);
  if (known.length !== seatIds.length) {
    throw new HttpError(404, 'NOT_FOUND', 'Seat not found for this show');
  }
}

// Backlog M4. Creation only: releasing a hold gives seats back, and rate
// limiting the way out of a mistake would be the wrong rule.
showsRouter.post('/:id/holds', requireAuth, rateLimitHolds, async (req, res) => {
  const found = await requireShow(req.params.id);
  const seatIds = seatIdList((req.body ?? {}).seat_ids);

  await requireSeatsOnScreen(found.screen.id, seatIds);

  const result = await acquireHolds({
    showId: found.show.id,
    seatIds,
    userId: req.user.id,
  });

  // Distinct from the booking path's SEATS_UNAVAILABLE on purpose: a held seat
  // is somebody else's seven-minute window, not a sold seat, and a client can
  // reasonably tell a user to try again shortly for one and not the other.
  if (!result.ok) {
    throw new HttpError(
      409,
      'SEATS_HELD',
      `Seat ${result.conflictSeatId} is already held by someone else`,
    );
  }

  // Module 6.3. After the hold is taken, never before, and never awaited: a
  // socket problem must not turn a successful hold into an error.
  void broadcastSeats(found.show.id, result.seatIds);

  res.status(201).json({
    hold: {
      show_id: found.show.id,
      seat_ids: result.seatIds,
      ttl_seconds: result.ttlSeconds,
    },
  });
});

showsRouter.delete('/:id/holds', requireAuth, async (req, res) => {
  const found = await requireShow(req.params.id);
  const seatIds = seatIdList((req.body ?? {}).seat_ids);

  // No existence check here. A hold that has already expired, and a seat that
  // was never held, are the same ordinary outcome: nothing to release. Turning
  // either into an error would make a client's cleanup path fail for succeeding.
  const { releasedSeatIds } = await releaseHolds({
    showId: found.show.id,
    seatIds,
    userId: req.user.id,
  });

  // Only what was actually released. Seats that had already expired changed
  // nothing, and announcing them would be describing a change that never
  // happened.
  void broadcastSeats(found.show.id, releasedSeatIds);

  res.json({
    released: {
      show_id: found.show.id,
      seat_ids: releasedSeatIds,
    },
  });
});

// ?seat_ids=1,2,3 or ?seat_ids=1&seat_ids=2 — both are what a client naturally
// produces, and neither is worth refusing.
function seatIdsFromQuery(value) {
  if (value === undefined) {
    throw validationError('seat_ids is required');
  }

  const raw = (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    typeof entry === 'string' ? entry.split(',') : entry,
  );

  return seatIdList(raw.map((entry) => (typeof entry === 'string' ? entry.trim() : entry)));
}

showsRouter.get('/:id/holds/ttl', requireAuth, async (req, res) => {
  const found = await requireShow(req.params.id);
  const seatIds = seatIdsFromQuery(req.query.seat_ids);

  const holds = [];

  for (const seatId of seatIds) {
    // Ownership first: this endpoint reports the caller's own holds and nobody
    // else's. A seat held by another user is omitted rather than refused —
    // "who else is holding this" is not a question this route answers, and the
    // show-wide version of it belongs to availabilityService in Module 4.3.
    const owner = await getHoldOwner({ showId: found.show.id, seatId });
    if (owner !== String(req.user.id)) continue;

    const ttl = await getHoldTtl({ showId: found.show.id, seatId });
    if (ttl === null) continue;

    holds.push({ seat_id: seatId, ttl_seconds: ttl });
  }

  res.json({ holds });
});
