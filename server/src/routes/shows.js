import { Router } from 'express';
import { HttpError } from '../lib/http-error.js';
import { getSeatStatus } from '../services/availabilityService.js';
import { getShowWithScreen } from '../services/catalogService.js';

export const showsRouter = Router();

showsRouter.get('/:id/seatmap', async (req, res) => {
  const found = await getShowWithScreen(req.params.id);
  if (!found) {
    throw new HttpError(404, 'NOT_FOUND', 'Show not found');
  }

  // Seat status comes from availabilityService and nowhere else.
  const seats = await getSeatStatus(found.show.id);

  res.json({ show: found.show, screen: found.screen, seats });
});
