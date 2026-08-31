import { Router } from 'express';
import { pool } from '../db/pool.js';
import { redis } from '../db/redis.js';
import { snapshot } from '../lib/metrics.js';
import { instanceId, metricsEnabled } from '../middleware/observability.js';
import { seatEventsStatus } from '../realtime/hub.js';

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

// Phase 9 M2. The inside view of the booking, hold, payment and availability
// paths — p50/p95/p99 measured in this process rather than inferred from
// outside it.
//
// Not part of the frozen Phase 0 contract above, and not reachable in
// production: timing detail is topology of a sort, and the same reasoning
// keeps the payment simulation controls out of production. 404 rather than 403,
// so a probe cannot tell the route exists and is merely disabled.
healthRouter.get('/metrics', (req, res) => {
  if (!metricsEnabled()) {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: `Cannot ${req.method} ${req.path}` },
    });
    return;
  }

  res.json({
    instance_id: instanceId(),
    uptime_seconds: Math.round(process.uptime()),
    // Phase 9 M3. Which instance answered, whether it can hear the others, and
    // how many sockets it is holding — so a multi-instance verification run can
    // assert on the topology instead of inferring it from behaviour.
    seat_events: seatEventsStatus(),
    ...snapshot(),
  });
});
