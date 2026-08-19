import { Router } from 'express';
import { idValue, seatIdList } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { createBooking } from '../services/bookingService.js';

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
