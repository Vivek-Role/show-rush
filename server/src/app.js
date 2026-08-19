import express from 'express';
import { authRouter } from './routes/auth.js';
import { bookingsRouter } from './routes/bookings.js';
import { healthRouter } from './routes/health.js';
import { moviesRouter } from './routes/movies.js';
import { showsRouter } from './routes/shows.js';
import { errorHandler, notFound } from './middleware/error.js';

// Assembly only — no listening, no client construction. index.js owns those,
// which is what lets the app be built without binding a port.
export function createApp() {
  const app = express();

  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/bookings', bookingsRouter);
  app.use('/api/movies', moviesRouter);
  app.use('/api/shows', showsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
