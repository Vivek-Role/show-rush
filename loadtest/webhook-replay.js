// Phase 5.4 — webhook replay.
//
// Every virtual user confirms the SAME payment event against the SAME booking.
// PLAN.md names this as one of two non-negotiables in the build: replaying one
// event 10,000 times concurrently must produce exactly one paid booking and
// exactly one payment_events row.
//
// This script only produces the requests. It never decides whether a run was
// good: counting what it produced is loadtest/count-payment-replay.sql, run
// against the database afterwards.
//
// Run it against a local server and a local Postgres. Never against Neon or
// Render — see loadtest/README.md.

import http from 'k6/http';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const SHOW_ID = __ENV.SHOW_ID || '1';
const VUS = Number(__ENV.VUS || 500);
const ITERATIONS = Number(__ENV.ITERATIONS || 20);
const EMAIL = __ENV.EMAIL || 'demo@show-rush.dev';
const PASSWORD = __ENV.PASSWORD || 'demo-password';

// VUS × ITERATIONS attempts — 10,000 by default, at a concurrency of 500.
// That is what this machine can actually produce, and it is what any recorded
// number says. "10,000 simultaneous connections" would be a different claim
// and an untrue one.
const BARRIER_MS = Number(__ENV.BARRIER_MS || 3000);

// One event id for the whole run, and a different one on the next run unless
// it is pinned. event_id is globally unique, so re-running against a database
// that already holds the previous run's event would report 10,000 duplicates
// and zero creations — a pass that measured nothing. Re-seeding clears it too;
// this makes the script safe either way.
const EVENT_ID = __ENV.EVENT_ID || `evt-replay-${Date.now()}`;

// One counter per outcome. These — not http_reqs — are the authoritative
// per-attempt numbers, because setup() also makes requests.
const created = new Counter('payment_created');
const duplicate = new Counter('payment_duplicate');
const conflict = new Counter('payment_conflict');
const otherClient = new Counter('payment_client_error');
const serverError = new Counter('payment_server_error');
const noResponse = new Counter('payment_no_response');

// 200 is the correct answer to a replay, not a failure — PLAN.md 5.2 fixes it
// there deliberately. Treating it as a failure would make http_req_failed
// useless for its actual job: telling us whether the load landed at all.
http.setResponseCallback(http.expectedStatuses(200, 201));

export const options = {
  scenarios: {
    replay: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: ITERATIONS,
      // Long enough that a slow run finishes; short enough that a hung server
      // does not stall the phase. A shortfall shows up as dropped_iterations.
      maxDuration: '5m',
      gracefulStop: '30s',
    },
  },

  // The same reasoning as seat-contention.js: a client that quietly reuses
  // sockets serialises the attempts and hides the race being measured.
  noConnectionReuse: true,

  // Deliberately no pass/fail gate — a threshold that aborted the run would
  // destroy the measurement. Both entries are always true; declaring them is
  // the documented way to make k6 report these tagged sub-metrics.
  thresholds: {
    'http_req_duration{endpoint:payment}': ['max>=0'],
    'http_req_failed{endpoint:payment}': ['rate>=0'],
  },
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function setup() {
  const login = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: JSON_HEADERS },
  );

  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status} ${login.body}`);
  }
  const token = login.json('token');
  const auth = { headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` } };

  const map = http.get(`${BASE_URL}/api/shows/${SHOW_ID}/seatmap`);
  if (map.status !== 200) {
    throw new Error(`seatmap for show ${SHOW_ID} failed: ${map.status} ${map.body}`);
  }

  const free = map.json('seats').filter((seat) => seat.status === 'available');
  if (free.length === 0) {
    throw new Error(`show ${SHOW_ID} has no available seat; re-seed before measuring`);
  }

  // One booking, made here rather than seeded, so the run always has a booking
  // in exactly the state a payment expects: pending, owned by this account.
  const booking = http.post(
    `${BASE_URL}/api/bookings`,
    JSON.stringify({ show_id: String(SHOW_ID), seat_ids: [String(free[0].id)] }),
    auth,
  );

  if (booking.status !== 201) {
    throw new Error(`could not create the booking to pay for: ${booking.status} ${booking.body}`);
  }

  const ref = booking.json('booking.booking_ref');
  const status = booking.json('booking.status');

  // A booking that is not pending would make every attempt a 409 and the run
  // would report zero creations while proving nothing — the same fail-fast
  // seat-contention.js applies to an already-booked seat.
  if (status !== 'pending') {
    throw new Error(`booking ${ref} is ${status}, not pending; the run would measure nothing`);
  }

  console.log(
    `target: booking ${ref}, event ${EVENT_ID}, ${VUS} VUs × ${ITERATIONS} = ${VUS * ITERATIONS} attempts`,
  );

  return { token, bookingRef: ref, eventId: EVENT_ID, startAt: Date.now() + BARRIER_MS };
}

export default function (data) {
  // The barrier governs the first iteration of every VU, so 500 attempts land
  // together; each VU then continues through its remaining iterations. The
  // duplicate path is what the rest of the run exercises, which is exactly the
  // load a replayed webhook produces.
  const wait = data.startAt - Date.now();
  if (wait > 0) sleep(wait / 1000);

  const res = http.post(
    `${BASE_URL}/api/payments/confirm`,
    JSON.stringify({ booking_ref: data.bookingRef, payment_event_id: data.eventId }),
    {
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${data.token}` },
      tags: { endpoint: 'payment' },
    },
  );

  // status 0 means k6 got no HTTP response at all — refused, reset or timed
  // out. That is the case where "exactly one booking" would mean nothing.
  if (res.status === 201) created.add(1);
  else if (res.status === 200) duplicate.add(1);
  else if (res.status === 409) conflict.add(1);
  else if (res.status === 0) noResponse.add(1);
  else if (res.status >= 500) serverError.add(1);
  else otherClient.add(1);
}

function value(data, metric, field) {
  const found = data.metrics[metric];
  if (!found || !found.values || found.values[field] === undefined) return 0;
  return found.values[field];
}

function ms(n) {
  return `${n.toFixed(1)}ms`;
}

// k6 embeds whatever setup() returned into the summary under setup_data, and
// setup() returns a live bearer token. The token is not part of any
// measurement, so it is replaced before anything is written to disk.
const REDACTED = '<redacted: bearer token, not part of the measurement>';

function withoutCredentials(summary) {
  if (!summary || !summary.setup_data) return summary;
  return { ...summary, setup_data: { ...summary.setup_data, token: REDACTED } };
}

export function handleSummary(data) {
  // From setup_data, never from the constant above: k6 runs module init once
  // per context, so the default `evt-replay-${Date.now()}` evaluated here is a
  // *different* id from the one setup() generated and the VUs actually sent.
  // Printing that one would put an event id in the record that no request ever
  // carried.
  const eventId = data.setup_data?.eventId ?? EVENT_ID;

  const attempts =
    value(data, 'payment_created', 'count') +
    value(data, 'payment_duplicate', 'count') +
    value(data, 'payment_conflict', 'count') +
    value(data, 'payment_client_error', 'count') +
    value(data, 'payment_server_error', 'count') +
    value(data, 'payment_no_response', 'count');

  const lines = [
    '',
    'webhook replay',
    `  base url             ${BASE_URL}`,
    `  event id             ${eventId}`,
    `  workload             ${VUS} VUs × ${ITERATIONS} iterations = ${VUS * ITERATIONS} attempts`,
    `  concurrency          ${VUS} in flight`,
    '',
    `  iterations           ${value(data, 'iterations', 'count')}`,
    `  dropped_iterations   ${value(data, 'dropped_iterations', 'count')}`,
    `  confirm attempts     ${attempts}`,
    '',
    `  201 created          ${value(data, 'payment_created', 'count')}   (must be 1)`,
    `  200 duplicate        ${value(data, 'payment_duplicate', 'count')}`,
    `  409 conflict         ${value(data, 'payment_conflict', 'count')}`,
    `  other 4xx            ${value(data, 'payment_client_error', 'count')}`,
    `  5xx                  ${value(data, 'payment_server_error', 'count')}`,
    `  no response          ${value(data, 'payment_no_response', 'count')}`,
    '',
    `  http_req_failed      ${(value(data, 'http_req_failed{endpoint:payment}', 'rate') * 100).toFixed(2)}%  (expected: 200, 201)`,
    `  http_req_duration    avg ${ms(value(data, 'http_req_duration{endpoint:payment}', 'avg'))}` +
      `  p95 ${ms(value(data, 'http_req_duration{endpoint:payment}', 'p(95)'))}` +
      `  max ${ms(value(data, 'http_req_duration{endpoint:payment}', 'max'))}`,
    '',
    '  This script counts responses, not rows.',
    '  Run loadtest/count-payment-replay.sql against the database next.',
    '',
  ];

  const out = { stdout: lines.join('\n') };

  // Raw evidence for the phase record, written only when asked for, so a
  // rehearsal run cannot overwrite a recorded measurement.
  if (__ENV.SUMMARY_OUT) {
    out[__ENV.SUMMARY_OUT] = JSON.stringify(withoutCredentials(data), null, 2);
  }

  return out;
}
