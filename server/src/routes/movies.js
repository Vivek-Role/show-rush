import { Router } from 'express';
import { HttpError } from '../lib/http-error.js';
import { getMovie, listMovies, listShowsForMovie } from '../services/catalogService.js';

// Public: browsing the catalogue must not require an account.
export const moviesRouter = Router();

moviesRouter.get('/', async (req, res) => {
  res.json(await listMovies());
});

moviesRouter.get('/:id/shows', async (req, res) => {
  const movie = await getMovie(req.params.id);
  if (!movie) {
    throw new HttpError(404, 'NOT_FOUND', 'Movie not found');
  }

  res.json({ movie, shows: await listShowsForMovie(movie.id) });
});
