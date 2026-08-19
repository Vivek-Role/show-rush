// Phase 2.2 — seat contention.
//
// Every virtual user tries to book the SAME seat on the SAME show at the same
// moment. Against BOOKING_MODE=naive this is expected to double-book (the
// "before" number); against BOOKING_MODE=safe, once Module 2.4 has added
// UNIQUE (show_id, seat_id), exactly one attempt may succeed.
//
// This script only produces the requests. It never decides whether a run was
// good: counting the damage is loadtest/count-double-bookings.sql, run against
// the database afterwards.
//
// Run it against a local server and a local Postgres. Never against Neon or
// Render — see loadtest/README.md.

import http from 'k6/http';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const SHOW_ID = __ENV.SHOW_ID || '1';
const VUS = Number(__ENV.VUS || 500);
const EMAIL = __ENV.EMAIL || 'demo@show-rush.dev';
const PASSWORD = __ENV.PASSWORD || 'demo-password';

// Every VU waits until this many milliseconds after setup() before firing, so
// the attempts land together instead of trickling in as k6 schedules each VU.
// "Simultaneous" is the workload PLAN.md 2.2 asks for; without the barrier the
// first attempt can commit before the last one has even read availability.
const BARRIER_MS = Number(__ENV.BARRIER_MS || 3000);

// One counter per outcome. These — not http_reqs — are the authoritative
// per-attempt numbers, because setup() also makes requests.
const created = new Counter('booking_created');
const conflict = new Counter('booking_conflict');
const otherClient = new Counter('booking_client_error');
const serverError = new Counter('booking_server_error');
const noResponse = new Counter('booking_no_response');

// 409 is a correct answer here, not a failure: it is what the fix is supposed
// to return. Treating it as a failure would make http_req_failed useless for
// its actual job — telling us whether the load landed at all.
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  scenarios: {
    contention: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      // Long enough that a slow run finishes; short enough that a hung server
      // does not stall the phase. A shortfall shows up as dropped_iterations.
      maxDuration: '2m',
      gracefulStop: '30s',
    },
  },

  // k6 reuses a connection within a VU. Each VU here does exactly one
  // iteration, but this is set explicitly because Module 2.1 found that a
  // client which quietly reuses sockets serialises the attempts and hides the
  // race completely. k6 already gives each VU its own connection pool; this
  // removes the remaining doubt.
  noConnectionReuse: true,

  // Deliberately no pass/fail gate — a threshold that aborted the run would
  // destroy the measurement. Both entries below are always true. Declaring
  // them is the documented way to make k6 report these tagged sub-metrics in
  // the summary, so booking latency and failure rate are reported without
  // setup()'s two requests mixed in.
  thresholds: {
    'http_req_duration{endpoint:booking}': ['max>=0'],
    'http_req_failed{endpoint:booking}': ['rate>=0'],
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

  const map = http.get(`${BASE_URL}/api/shows/${SHOW_ID}/seatmap`);
  if (map.status !== 200) {
    throw new Error(`seatmap for show ${SHOW_ID} failed: ${map.status} ${map.body}`);
  }
  const seats = map.json('seats');

  let seatId = __ENV.SEAT_ID;

  if (seatId) {
    const target = seats.find((seat) => String(seat.id) === String(seatId));
    if (!target) {
      throw new Error(`seat ${seatId} is not a seat of show ${SHOW_ID}`);
    }
    if (target.status !== 'available') {
      throw new Error(`seat ${seatId} is already ${target.status}; the run would measure nothing`);
    }
  } else {
    // Deterministic against a freshly seeded database: the same seat every
    // time, so two runs are comparable without anyone remembering an id.
    const free = seats.filter((seat) => seat.status === 'available');
    if (free.length === 0) {
      throw new Error(`show ${SHOW_ID} has no available seat; re-seed before measuring`);
    }
    seatId = String(free[0].id);
  }

  console.log(`target: show ${SHOW_ID}, seat ${seatId}, ${VUS} VUs, ${BASE_URL}`);

  return { token, showId: String(SHOW_ID), seatId: String(seatId), startAt: Date.now() + BARRIER_MS };
}

export default function (data) {
  const wait = data.startAt - Date.now();
  if (wait > 0) sleep(wait / 1000);

  const res = http.post(
    `${BASE_URL}/api/bookings`,
    JSON.stringify({ show_id: data.showId, seat_ids: [data.seatId] }),
    {
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${data.token}` },
      tags: { endpoint: 'booking' },
    },
  );

  // status 0 means k6 got no HTTP response at all — refused, reset or timed
  // out. That is the case where "0 double-bookings" would mean nothing.
  if (res.status === 201) created.add(1);
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

export function handleSummary(data) {
  const attempts =
    value(data, 'booking_created', 'count') +
    value(data, 'booking_conflict', 'count') +
    value(data, 'booking_client_error', 'count') +
    value(data, 'booking_server_error', 'count') +
    value(data, 'booking_no_response', 'count');

  const lines = [
    '',
    'seat contention',
    `  base url             ${BASE_URL}`,
    `  show / seat          ${SHOW_ID} / ${__ENV.SEAT_ID || 'first available'}`,
    `  VUs configured       ${VUS}`,
    '',
    `  iterations           ${value(data, 'iterations', 'count')}`,
    `  dropped_iterations   ${value(data, 'dropped_iterations', 'count')}`,
    `  booking attempts     ${attempts}`,
    '',
    `  201 created          ${value(data, 'booking_created', 'count')}`,
    `  409 conflict         ${value(data, 'booking_conflict', 'count')}`,
    `  other 4xx            ${value(data, 'booking_client_error', 'count')}`,
    `  5xx                  ${value(data, 'booking_server_error', 'count')}`,
    `  no response          ${value(data, 'booking_no_response', 'count')}`,
    '',
    `  http_req_failed      ${(value(data, 'http_req_failed{endpoint:booking}', 'rate') * 100).toFixed(2)}%  (expected: 201, 409)`,
    `  http_req_duration    avg ${ms(value(data, 'http_req_duration{endpoint:booking}', 'avg'))}` +
      `  p95 ${ms(value(data, 'http_req_duration{endpoint:booking}', 'p(95)'))}` +
      `  max ${ms(value(data, 'http_req_duration{endpoint:booking}', 'max'))}`,
    '',
    '  This script counts responses, not double-bookings.',
    '  Run loadtest/count-double-bookings.sql against the database next.',
    '',
  ];

  const out = { stdout: lines.join('\n') };

  // Raw evidence for the phase record, written only when asked for, so a
  // rehearsal run cannot overwrite a recorded measurement.
  if (__ENV.SUMMARY_OUT) {
    out[__ENV.SUMMARY_OUT] = JSON.stringify(data, null, 2);
  }

  return out;
}
