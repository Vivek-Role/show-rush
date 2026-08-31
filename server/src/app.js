import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { config } from './config/env.js';
import { authRouter } from './routes/auth.js';
import { bookingsRouter } from './routes/bookings.js';
import { healthRouter } from './routes/health.js';
import { moviesRouter } from './routes/movies.js';
import { paymentsRouter } from './routes/payments.js';
import { showsRouter } from './routes/shows.js';
import { errorHandler, notFound } from './middleware/error.js';
import { observability } from './middleware/observability.js';

// Assembly only — no listening, no client construction. index.js owns those,
// which is what lets the app be built without binding a port.
export function createApp() {
  const app = express();

  // Phase 9 M2. First, ahead of CORS: a request refused by CORS is still a
  // request, and a log that silently omits the refused ones is the log you
  // most want when a browser client cannot reach the API.
  app.use(observability);

  // One exact origin, never a wildcard — a wildcard is incompatible with
  // credentialed requests anyway, and the browser client sends its cookie on
  // every call. An unset CLIENT_ORIGIN sends no allow-origin header at all, so
  // browsers fail closed; curl and k6 are unaffected, because CORS is a rule
  // browsers apply to themselves.
  app.use(
    cors({
      origin: config.clientOrigin,
      credentials: true,
      // DELETE joins the list for Module 4.2's release-hold route: without it
      // the browser's preflight refuses the request before it is ever sent.
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    }),
  );

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use(healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/bookings', bookingsRouter);
  app.use('/api/movies', moviesRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/shows', showsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
