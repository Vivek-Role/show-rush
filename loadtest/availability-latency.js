// Phase 7.1 — availability query latency.
//
// The last of the four claims PLAN.md 7.1 names. GET /api/shows/:id/seatmap is
// the one availability read path in the system: one Postgres query over the
// show's seats, then one Redis MGET whose width is the seat count, merged in
// availabilityService and nowhere else. This measures how long that costs.
//
// ANONYMOUS ON PURPOSE. The route is optionalAuth, and a signed-in viewer gets
// a different merge — their own holds are reported back to them as available.
// Holding that constant keeps one variable in play. The signed-in path is
// therefore NOT measured here, and the phase record says so rather than
// implying this number covers it.
//
// constant-arrival-rate, not constant-vus: this is a latency measurement at a
// stated offered load, not a search for the point where the server falls over.
// If k6 cannot sustain the rate it says so in dropped_iterations, which is the
// first number to read.
//
// SINGLE-POINT measurement. Nothing was optimised to produce it and there is no
// "before" — PLAN.md 7.4 requires that label in the results table.
//
// Run it against a local server and a local Postgres/Redis. Never against Neon
// or Render — see loadtest/README.md.

import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const SHOW_ID = __ENV.SHOW_ID || '1';
const RATE = Number(__ENV.RATE || 50);
const DURATION = __ENV.DURATION || '60s';
const EMAIL = __ENV.EMAIL || 'demo@show-rush.dev';
const PASSWORD = __ENV.PASSWORD || 'demo-password';

// How many seats to hold before the run starts, so the MGET returns hits
// instead of an all-miss reply. Redis answers a miss and a hit over the same
// round trip, but "we only ever measured the empty case" is not something a
// recorded number should have to admit later. 0 measures the cold map.
const HOLD_SEATS = Number(__ENV.HOLD_SEATS || 0);

const mapOk = new Counter('map_ok');
const failed = new Counter('map_failed');
const noResponse = new Counter('map_no_response');

http.setResponseCallback(http.expectedStatuses(200));

export const options = {
  scenarios: {
    availability: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      // Enough VUs that a slow response cannot starve the arrival rate and
      // silently turn this into a closed-loop test. A shortfall still shows up
      // as dropped_iterations rather than as quietly reduced load.
      preAllocatedVUs: Math.max(RATE, 50),
      maxVUs: Math.max(RATE * 4, 200),
      gracefulStop: '15s',
    },
  },

  noConnectionReuse: false,

  thresholds: {
    'http_req_duration{endpoint:seatmap}': ['max>=0'],
    'http_req_failed{endpoint:seatmap}': ['rate>=0'],
  },

  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function setup() {
  const map = http.get(`${BASE_URL}/api/shows/${SHOW_ID}/seatmap`);
  if (map.status !== 200) {
    throw new Error(`seatmap for show ${SHOW_ID} failed: ${map.status} ${map.body}`);
  }

  const seats = map.json('seats');

  // Recorded in the summary so every raw file carries the dataset it ran
  // against. A latency number without its seat count is not comparable to
  // anything, and the whole point of running this twice is the comparison.
  const byStatus = {};
  for (const seat of seats) byStatus[seat.status] = (byStatus[seat.status] ?? 0) + 1;

  let token = null;
  let heldSeatIds = [];

  if (HOLD_SEATS > 0) {
    const login = http.post(
      `${BASE_URL}/api/auth/login`,
      JSON.stringify({ email: EMAIL, password: PASSWORD }),
      { headers: JSON_HEADERS },
    );
    if (login.status !== 200) {
      throw new Error(`login failed: ${login.status} ${login.body}`);
    }
    token = login.json('token');

    const free = seats.filter((seat) => seat.status === 'available').map((seat) => String(seat.id));
    if (free.length < HOLD_SEATS) {
      throw new Error(`show ${SHOW_ID} has ${free.length} available seats; HOLD_SEATS=${HOLD_SEATS}`);
    }

    // One request per seat. holdService acquires all-or-nothing per call, and a
    // single 200-seat call failing on its last seat would roll the whole thing
    // back and leave the run measuring the cold map while claiming otherwise.
    for (const seatId of free.slice(0, HOLD_SEATS)) {
      const res = http.post(
        `${BASE_URL}/api/shows/${SHOW_ID}/holds`,
        JSON.stringify({ show_id: String(SHOW_ID), seat_ids: [seatId] }),
        { headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` } },
      );
      if (res.status === 201) heldSeatIds.push(seatId);
    }

    if (heldSeatIds.length !== HOLD_SEATS) {
      throw new Error(
        `asked for ${HOLD_SEATS} holds, got ${heldSeatIds.length}. Re-seed and retry.`,
      );
    }
  }

  console.log(
    `show ${SHOW_ID}: ${seats.length} seats (${JSON.stringify(byStatus)}), ` +
      `${heldSeatIds.length} pre-held, ${RATE}/s for ${DURATION}, ${BASE_URL}`,
  );

  return {
    token,
    showId: String(SHOW_ID),
    seatCount: seats.length,
    seatsByStatus: byStatus,
    heldSeatIds,
  };
}

export default function (data) {
  // No Authorization header — see the module comment.
  const res = http.get(`${BASE_URL}/api/shows/${data.showId}/seatmap`, {
    tags: { endpoint: 'seatmap' },
  });

  if (res.status === 200) mapOk.add(1);
  else if (res.status === 0) noResponse.add(1);
  else failed.add(1);
}

export function teardown(data) {
  // Give the seats back. A held seat surviving the run would change what the
  // next script's setup() sees, and loadtest/README.md's rule is that a run
  // starts from a known database.
  if (!data.token || data.heldSeatIds.length === 0) return;

  http.request(
    'DELETE',
    `${BASE_URL}/api/shows/${data.showId}/holds`,
    JSON.stringify({ show_id: data.showId, seat_ids: data.heldSeatIds }),
    { headers: { ...JSON_HEADERS, Authorization: `Bearer ${data.token}` } },
  );
}

function value(data, metric, field) {
  const found = data.metrics[metric];
  if (!found || !found.values || found.values[field] === undefined) return 0;
  return found.values[field];
}

function ms(n) {
  return `${n.toFixed(1)}ms`;
}

const REDACTED = '<redacted: bearer token, not part of the measurement>';

function withoutCredentials(summary) {
  if (!summary || !summary.setup_data) return summary;
  return { ...summary, setup_data: { ...summary.setup_data, token: REDACTED } };
}

export function handleSummary(data) {
  const seatCount = data.setup_data ? data.setup_data.seatCount : 0;
  const held = data.setup_data ? data.setup_data.heldSeatIds.length : 0;
  const metric = 'http_req_duration{endpoint:seatmap}';

  const lines = [
    '',
    'availability query latency  (single-point measurement — no before/after)',
    `  base url             ${BASE_URL}`,
    `  show                 ${SHOW_ID}`,
    `  seats in the map     ${seatCount}      <- the MGET width`,
    `  seats pre-held       ${held}`,
    `  offered rate         ${RATE}/s for ${DURATION}`,
    `  auth                 anonymous (optionalAuth path NOT measured)`,
    '',
    `  iterations           ${value(data, 'iterations', 'count')}`,
    `  dropped_iterations   ${value(data, 'dropped_iterations', 'count')}`,
    `  achieved rate        ${value(data, 'map_ok', 'rate').toFixed(1)}/s`,
    '',
    `  200 ok               ${value(data, 'map_ok', 'count')}`,
    `  failed               ${value(data, 'map_failed', 'count')}`,
    `  no response          ${value(data, 'map_no_response', 'count')}`,
    '',
    `  latency              avg ${ms(value(data, metric, 'avg'))}` +
      `  med ${ms(value(data, metric, 'med'))}` +
      `  p95 ${ms(value(data, metric, 'p(95)'))}` +
      `  p99 ${ms(value(data, metric, 'p(99)'))}` +
      `  max ${ms(value(data, metric, 'max'))}`,
    `  http_req_failed      ${(value(data, 'http_req_failed{endpoint:seatmap}', 'rate') * 100).toFixed(2)}%  (expected: 200)`,
    '',
    '  dropped_iterations above zero means the offered rate was not delivered.',
    '  Read it before the latency: a rate that never landed has cheap latency.',
    '',
  ];

  const out = { stdout: lines.join('\n') };

  if (__ENV.SUMMARY_OUT) {
    out[__ENV.SUMMARY_OUT] = JSON.stringify(withoutCredentials(data), null, 2);
  }

  return out;
}
