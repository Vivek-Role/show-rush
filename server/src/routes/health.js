import { Router } from 'express';
import { pool } from '../db/pool.js';
import { redis } from '../db/redis.js';

export const healthRouter = Router();

// Both responses below are a frozen Phase 0 contract. render.yaml points its
// healthCheckPath at '/', so changing either shape breaks the deployment.

healthRouter.get('/', (req, res) => {
  res.json({ service: 'show-rush', status: 'ok' });
});

healthRouter.get('/health', async (req, res) => {
  const [db, cache] = await Promise.all([
    pool
      ? pool
          .query('select 1')
          .then(() => 'ok')
          .catch(() => 'error')
      : Promise.resolve('error'),
    redis?.isOpen
      ? redis
          .ping()
          .then(() => 'ok')
          .catch(() => 'error')
      : Promise.resolve('error'),
  ]);

  // Status only — never versions, hosts, or error detail that leaks topology.
  const healthy = db === 'ok' && cache === 'ok';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    db,
    redis: cache,
  });
});
