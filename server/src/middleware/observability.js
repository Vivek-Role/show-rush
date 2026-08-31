import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { record } from '../lib/metrics.js';

// Phase 9 M2 — request ids, one structured line per request, and timing on the
// paths that matter.
//
// This middleware observes. It never changes a status code, a body, or a
// header a client depends on, and a fault inside it must never cost a booking —
// every write below is wrapped, because a logging bug that returns 500 on the
// booking path would be a far worse outcome than no logs at all.
//
// It does not reach into any service. Everything here happens at the
// request boundary, which is what keeps the diff small and keeps
// availabilityService, holdService and bookingService untouched.
//
// The WebSocket hub is deliberately not instrumented. M3 rewrites that path for
// Redis pub/sub fan-out, and instrumenting it now would mean writing it twice.

// The four paths the approved plan names. A Set of "METHOD pattern", checked
// against the route pattern Express resolved — never the URL. `/api/shows/1/
// holds` and `/api/shows/2/holds` are one key, which is what keeps the metrics
// map the size of the routing table instead of the size of the traffic.
const TRACKED = new Set([
  'POST /api/bookings',
  'POST /api/shows/:id/holds',
  'DELETE /api/shows/:id/holds',
  'POST /api/payments/confirm',
  'GET /api/shows/:id/seatmap',
]);

// A request id arrives from a proxy or another service, or it is minted here.
// Constrained on the way in because it is echoed back in a header and written
// to a log line: an unvalidated value is a header-injection and log-forging
// vector, and neither is worth the convenience of accepting anything.
const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

// One instance among several once M3 lands. Not the hostname: logs are read
// locally and a hostname in every line is topology nobody asked for.
const INSTANCE_ID = config.instanceId || `local-${process.pid}`;

export function instanceId() {
  return INSTANCE_ID;
}

/**
 * Metrics are a development and benchmarking affordance, not a product feature.
 * Refused in production for the same reason paymentService.simulationAllowed()
 * refuses the payment simulation controls there: a switch that exposes how the
 * system behaves internally should not be reachable from the outside world.
 */
export function metricsEnabled() {
  return config.nodeEnv !== 'production';
}

function segments(path) {
  return path.split('/').filter(Boolean);
}

/**
 * The route Express actually matched, as a pattern.
 *
 * Available only after routing, which is why the log is written on finish
 * rather than on the way in. A request that matched nothing has no pattern and
 * must not contribute its URL — that is precisely the unbounded-cardinality
 * case — so it is bucketed under a single sentinel.
 *
 * The mount prefix is reconstructed from `req.originalUrl` rather than read
 * from `req.baseUrl`, and that is not a stylistic choice. Express restores
 * `baseUrl` as it unwinds the router stack, so by the time 'finish' fires it is
 * intact for a handler that responded normally and empty for one whose error
 * propagated to the app-level error handler. Reading it produced
 * '/api/shows/:id/seatmap' for a 200 and '/:id/holds' for a 403 — the same
 * route under two keys, which is both wrong data and the cardinality leak this
 * function exists to prevent. `originalUrl` is never rewritten, so counting the
 * matched route's own segments off the end of it gives the prefix regardless of
 * how the response was produced.
 */
function routePattern(req) {
  const path = req.route?.path;
  if (typeof path !== 'string') return '(unmatched)';

  const routeParts = segments(path);
  const urlParts = segments((req.originalUrl ?? '').split('?')[0]);
  const prefix = urlParts.slice(0, Math.max(0, urlParts.length - routeParts.length));

  return `/${[...prefix, ...routeParts].join('/')}`;
}

function level(status) {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

export function observability(req, res, next) {
  const inbound = req.get('x-request-id');
  req.id = inbound && REQUEST_ID.test(inbound) ? inbound : randomUUID();

  // Echoed so a caller can correlate its own logs with the server's without
  // having to parse a body.
  res.setHeader('X-Request-Id', req.id);

  const started = process.hrtime.bigint();
  let written = false;

  // 'finish' is the response completing; 'close' catches a client that
  // disconnected mid-flight. Whichever fires first wins, and the flag stops the
  // other one writing a second line for the same request.
  const done = () => {
    if (written) return;
    written = true;

    try {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const pattern = routePattern(req);
      const key = `${req.method} ${pattern}`;

      if (TRACKED.has(key)) record(key, durationMs);

      // Method, route pattern, status, duration, ids. Never a body, a header, a
      // cookie, a token, an email, or a query string — a log line is a place
      // secrets go to be read later by whoever has the log.
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: level(res.statusCode),
          instance_id: INSTANCE_ID,
          req_id: req.id,
          method: req.method,
          route: pattern,
          status: res.statusCode,
          duration_ms: Math.round(durationMs * 100) / 100,
        }),
      );
    } catch {
      // A broken log line is not a reason to break the request it describes.
      // There is nothing useful to report here — reporting it would need the
      // same machinery that just failed.
    }
  };

  res.on('finish', done);
  res.on('close', done);

  next();
}
