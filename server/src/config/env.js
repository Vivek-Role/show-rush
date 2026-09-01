import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// npm start runs with cwd=server/, so the repo-root .env must be resolved
// explicitly. On Render there is no .env and the platform supplies the vars.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../../.env'), quiet: true });

// .env.example is the single source of truth for these names. Anything reading
// an env var not listed there is a bug.
export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT) || 3000,
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  // The exact origin the browser client is served from. Empty means no browser
  // client is allowed through CORS at all, which is the safe default.
  clientOrigin: process.env.CLIENT_ORIGIN ?? '',
  // Defaults to 'safe' so that an unset variable can never deploy the racy
  // booking path. Enabling 'naive' is always a deliberate act.
  bookingMode: (process.env.BOOKING_MODE ?? 'safe').trim().toLowerCase(),
  // Phase 9 M2. Which instance wrote a log line. Empty is normal for a single
  // process — observability.js falls back to the pid — and it earns its keep in
  // M3, where several instances write to the same place.
  instanceId: (process.env.INSTANCE_ID ?? '').trim(),
  // Module 6.2. How long a booking may sit 'pending' before the sweep expires
  // it and gives its seats back. Must exceed the hold TTL — reconcileService
  // asserts that, where holdService's constant is importable without a cycle.
  pendingBookingTtlSeconds: intFromEnv(process.env.PENDING_BOOKING_TTL_SECONDS, 900),
  // How often the in-process sweep runs. 0 disables the interval entirely while
  // leaving `npm run reconcile` available — which is how a Phase 2 or Phase 5
  // benchmark guarantees nothing mutated bookings underneath it.
  reconcileIntervalSeconds: intFromEnv(process.env.RECONCILE_INTERVAL_SECONDS, 60),
  // How many hold requests one signed-in user may make per window. The limit is
  // per user rather than per IP, because the thing being prevented is one
  // account holding a whole screen, and an IP is neither an account nor stable
  // behind a proxy.
  //
  // 0 disables the limiter entirely, exactly as RECONCILE_INTERVAL_SECONDS=0
  // disables the sweep — and for the same reason: a hold benchmark drives
  // hundreds of requests a second as a single user, so a limiter left on would
  // be measuring itself rather than the hold path.
  holdRateLimit: intFromEnv(process.env.HOLD_RATE_LIMIT, 30),
  holdRateWindowSeconds: intFromEnv(process.env.HOLD_RATE_WINDOW_SECONDS, 60),
  // BACKLOG.md P2 — the virtual waiting room, per show.
  //
  // A list of show ids rather than a switch: a room on every show would
  // throttle the quiet ones for nothing. Empty — the default — means no show
  // has one, so every existing benchmark, test and demo is untouched.
  waitingRoomShows: (process.env.WAITING_ROOM_SHOWS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  // How many people the room lets through per minute, and how many it admits
  // the instant a queue opens so a quiet show never makes anyone wait.
  waitingRoomRatePerMinute: intFromEnv(process.env.WAITING_ROOM_RATE_PER_MINUTE, 60),
  waitingRoomInitialAdmit: intFromEnv(process.env.WAITING_ROOM_INITIAL_ADMIT, 60),
  // A ticket outlives a long wait but not the visitor's session. Expiry is not
  // an error: the holder simply joins again.
  waitingRoomTicketTtlSeconds: intFromEnv(process.env.WAITING_ROOM_TICKET_TTL_SECONDS, 1800),
};

// NaN rather than the fallback for a malformed value: an unset variable means
// "use the default", but 'sixty' means somebody tried to configure this and
// got it wrong. Silently defaulting would hide that, and assertReconcileConfig
// turns it into a refusal to start.
function intFromEnv(value, fallback) {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

// Unlike the connection strings, a missing signing secret is fatal: signing
// with an empty or defaulted secret would make every token forgeable, so
// degrading is not an option. authService calls this at import, which means
// the server refuses to start without it while the migration runner — which
// needs no secret — is unaffected.
export function assertAuthConfig() {
  if (!config.jwtSecret) {
    throw new Error('JWT_SECRET is not set. See .env.example.');
  }
}

// BOOKING_MODE=naive is the deliberately racy path Phase 2 measures. It exists
// permanently so the "before" number stays reproducible, and it must never
// serve real users — a double-booked seat in production is not an experiment.
// bookingService calls this at import, so a misconfigured server refuses to
// start rather than discovering the problem under load.
export function assertBookingConfig() {
  if (config.bookingMode !== 'naive' && config.bookingMode !== 'safe') {
    throw new Error(
      `BOOKING_MODE must be 'naive' or 'safe', got '${config.bookingMode}'. See .env.example.`,
    );
  }

  if (config.bookingMode === 'naive' && config.nodeEnv === 'production') {
    throw new Error(
      'BOOKING_MODE=naive must never run with NODE_ENV=production. ' +
        'The naive path double-books by design. See .env.example.',
    );
  }
}

// Module 6.2. The sweep changes booking status on its own schedule, so a
// misconfigured interval is not a cosmetic problem: a negative or unparseable
// value would either never run or run continuously. reconcileService calls this
// at import — the same posture bookingService takes for BOOKING_MODE — so the
// server and the CLI both refuse to start rather than sweeping wrongly.
//
// The "must exceed the hold TTL" rule lives in reconcileService, not here:
// importing holdService from this module would be a cycle.
export function assertReconcileConfig() {
  if (!Number.isInteger(config.pendingBookingTtlSeconds) || config.pendingBookingTtlSeconds <= 0) {
    throw new Error(
      'PENDING_BOOKING_TTL_SECONDS must be a positive integer number of seconds. See .env.example.',
    );
  }

  // 0 is meaningful here and is not an error: it disables the interval.
  if (!Number.isInteger(config.reconcileIntervalSeconds) || config.reconcileIntervalSeconds < 0) {
    throw new Error(
      'RECONCILE_INTERVAL_SECONDS must be a non-negative integer number of seconds, ' +
        'where 0 disables the periodic sweep. See .env.example.',
    );
  }
}

// Absent connection strings are reported, not fatal: both clients default to
// localhost when handed nothing, which can silently connect to an unrelated
// service. Missing config degrades /health to 503 rather than killing the
// process, which is the behaviour Phase 0 verified.
export function missingConnectionVars() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.redisUrl) missing.push('REDIS_URL');
  return missing;
}
