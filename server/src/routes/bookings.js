import { Router } from 'express';
import { bookingRef, idValue, seatIdList } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { cancelBooking, createBooking } from '../services/bookingService.js';

// The first write path in the application. Unlike the catalogue, it requires a
// token — a booking belongs to somebody.
export const bookingsRouter = Router();

bookingsRouter.post('/', requireAuth, async (req, res) => {
  const body = req.body ?? {};

  const booking = await createBooking({
    userId: req.user.id,
    showId: idValue(body.show_id, 'show_id'),
    seatIds: seatIdList(body.seat_ids),
  });

  res.status(201).json({ booking });
});

// BACKLOG.md P2 — cancellation + refund flow.
//
// POST rather than DELETE, and /cancel rather than the collection resource: a
// booking is not deleted, it moves to a terminal status and keeps its history,
// and DELETE would describe the opposite. It is also the shape that leaves room
// for a body — a cancellation reason, a partial seat list — without changing the
// method later.
//
// The reference travels in the path, matching how the payment route takes it in
// the body: both are the public identifier, never the integer id.
bookingsRouter.post('/:ref/cancel', requireAuth, async (req, res) => {
  const booking = await cancelBooking({
    userId: req.user.id,
    bookingRef: bookingRef(req.params.ref, 'ref'),
  });

  // 200, not 204: the caller needs the resulting status to know whether a
  // refund is owed, and an empty body would make them ask again to find out.
  res.json({ booking });
});
