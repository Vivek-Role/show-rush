// Phase 7.1 — hold throughput.
//
// One of the four claims PLAN.md 7.1 names. Virtual users acquire and release
// seat holds as fast as the local stack will answer, and this reports the rate
// and the latency distribution.
//
// UNCONTENDED BY CONSTRUCTION. Every VU is given its own disjoint slice of
// seats, so two VUs never reach for the same seat. Contention is already
// measured by seat-contention.js and is a different claim; mixing the two would
// produce a number that is neither. If any 409 appears the run was not
// uncontended, and the summary says so rather than letting it pass.
//
// This is a SINGLE-POINT measurement. There is no "before" to compare it to and
// nothing was optimised to produce it, so PLAN.md 7.4 requires it to be
// labelled that way in the results table.
//
// Not to be confused with seat-churn.js, which is a Phase 6 *generator* for
// loading the browser and reports no performance figure at all. This script is
// the benchmark; that one is the stimulus.
//
// Run it against a local server and a local Postgres/Redis. Never against Neon
// or Render — see loadtest/README.md.

import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const SHOW_ID = __ENV.SHOW_ID || '1';
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '60s';
const EMAIL = __ENV.EMAIL || 'demo@show-rush.dev';
const PASSWORD = __ENV.PASSWORD || 'demo-password';

// Seats held per request. A hold is all-or-nothing across the whole slice
// (holdService acquires in sorted order), so this also sets how much work a
// single acquire does.
const SEATS_PER_VU = Number(__ENV.SEATS_PER_VU || 4);

// Purely a label. Module 7.3a runs this script three times with 0, 1 and 50
// connected WebSocket watchers to price the per-change broadcast; recording the
// watcher count inside the summary is what keeps those three raw files told
// apart afterwards. The script itself opens no sockets and behaves identically
// whatever this says.
const WATCHERS = __ENV.WATCHERS || '0';

const holdOk = new Counter('hold_ok');
const holdConflict = new Counter('hold_conflict');
const releaseOk = new Counter('release_ok');
const failed = new Counter('hold_failed');
const noResponse = new Counter('hold_no_response');

// 409 is not expected here — the slices are disjoint — but it is still a
// well-formed refusal rather than a broken request, so it must not inflate
// http_req_failed, whose job is to say whether the load landed at all. It is
// reported separately and loudly instead.
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  scenarios: {
    holds: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      gracefulStop: '15s',
    },
  },

  // Left at the k6 default, unlike seat-contention.js. That script disables
  // reuse because socket reuse serialises a race and hides it; here there is no
  // race to hide, and forcing a fresh TCP connection per request would measure
  // this laptop's connection setup rather than the hold path.
  noConnectionReuse: false,

  // Always true. Declared so k6 reports the tagged sub-metrics separately —
  // otherwise setup()'s login and seat-map fetch are mixed into the latency.
  thresholds: {
    'http_req_duration{endpoint:hold}': ['max>=0'],
    'http_req_duration{endpoint:release}': ['max>=0'],
    'http_req_failed{endpoint:hold}': ['rate>=0'],
  },

  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
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

  const free = map.json('seats').filter((seat) => seat.status === 'available');
  const needed = VUS * SEATS_PER_VU;

  // Refuse rather than degrade. Without enough seats the slices would have to
  // overlap, and the run would quietly become a contention test reporting
  // itself as a throughput test.
  if (free.length < needed) {
    throw new Error(
      `show ${SHOW_ID} has ${free.length} available seats; ` +
        `${VUS} VUs x ${SEATS_PER_VU} seats needs ${needed}. ` +
        'Re-seed, use the stress show (npm run seed:stress), or lower VUS/SEATS_PER_VU.',
    );
  }

  // One contiguous slice per VU, cut in seat-map order. Disjointness is the
  // only property that matters; contiguity just makes a failure easy to read.
  const slices = [];
  for (let i = 0; i < VUS; i += 1) {
    slices.push(free.slice(i * SEATS_PER_VU, (i + 1) * SEATS_PER_VU).map((seat) => String(seat.id)));
  }

  console.log(
    `show ${SHOW_ID}: ${free.length} free seats, ${VUS} VUs x ${SEATS_PER_VU} seats ` +
      `= ${needed} claimed, watchers=${WATCHERS}, ${BASE_URL}`,
  );

  return { token, showId: String(SHOW_ID), slices, seatsFree: free.length };
}

export default function (data) {
  // __VU is 1-based and constant for the life of a VU, so each VU keeps the
  // same seats for the whole run.
  const seatIds = data.slices[(__VU - 1) % data.slices.length];
  const auth = { ...JSON_HEADERS, Authorization: `Bearer ${data.token}` };
  const body = JSON.stringify({ show_id: data.showId, seat_ids: seatIds });

  const held = http.post(`${BASE_URL}/api/shows/${data.showId}/holds`, body, {
    headers: auth,
    tags: { endpoint: 'hold' },
  });

  if (held.status === 201) holdOk.add(1);
  else if (held.status === 409) holdConflict.add(1);
  else if (held.status === 0) noResponse.add(1);
  else failed.add(1);

  // Released whether or not the acquire succeeded: releaseHolds is a
  // compare-and-delete that touches nothing it does not own, so releasing seats
  // this VU never held is a no-op rather than an error. Skipping it would leave
  // the slice held for the full 420 s TTL and starve every later iteration.
  const released = http.request('DELETE', `${BASE_URL}/api/shows/${data.showId}/holds`, body, {
    headers: auth,
    tags: { endpoint: 'release' },
  });

  if (released.status === 200) releaseOk.add(1);
  else if (released.status === 0) noResponse.add(1);
  else failed.add(1);
}

function value(data, metric, field) {
  const found = data.metrics[metric];
  if (!found || !found.values || found.values[field] === undefined) return 0;
  return found.values[field];
}

function ms(n) {
  return `${n.toFixed(1)}ms`;
}

function trend(data, metric) {
  return (
    `avg ${ms(value(data, metric, 'avg'))}` +
    `  med ${ms(value(data, metric, 'med'))}` +
    `  p95 ${ms(value(data, metric, 'p(95)'))}` +
    `  p99 ${ms(value(data, metric, 'p(99)'))}` +
    `  max ${ms(value(data, metric, 'max'))}`
  );
}

// setup() returns a live bearer token and k6 embeds it in the summary. Written
// verbatim, every recorded run would commit a working credential. The token is
// no part of the measurement, so it is replaced before anything is written.
// Identical to seat-contention.js on purpose.
const REDACTED = '<redacted: bearer token, not part of the measurement>';

function withoutCredentials(summary) {
  if (!summary || !summary.setup_data) return summary;
  return { ...summary, setup_data: { ...summary.setup_data, token: REDACTED } };
}

export function handleSummary(data) {
  const conflicts = value(data, 'hold_conflict', 'count');

  const lines = [
    '',
    'hold throughput  (single-point measurement — no before/after)',
    `  base url             ${BASE_URL}`,
    `  show                 ${SHOW_ID}`,
    `  VUs / seats per VU   ${VUS} / ${SEATS_PER_VU}`,
    `  duration             ${DURATION}`,
    `  ws watchers          ${WATCHERS}`,
    '',
    `  iterations           ${value(data, 'iterations', 'count')}`,
    `  dropped_iterations   ${value(data, 'dropped_iterations', 'count')}`,
    '',
    `  201 holds            ${value(data, 'hold_ok', 'count')}`,
    `  200 releases         ${value(data, 'release_ok', 'count')}`,
    `  409 conflicts        ${conflicts}`,
    `  failed               ${value(data, 'hold_failed', 'count')}`,
    `  no response          ${value(data, 'hold_no_response', 'count')}`,
    '',
    `  holds/sec            ${value(data, 'hold_ok', 'rate').toFixed(1)}`,
    `  releases/sec         ${value(data, 'release_ok', 'rate').toFixed(1)}`,
    '',
    `  hold latency         ${trend(data, 'http_req_duration{endpoint:hold}')}`,
    `  release latency      ${trend(data, 'http_req_duration{endpoint:release}')}`,
    `  http_req_failed      ${(value(data, 'http_req_failed{endpoint:hold}', 'rate') * 100).toFixed(2)}%  (expected: 200, 201, 409)`,
    '',
  ];

  if (conflicts > 0) {
    lines.push(
      '  WARNING: conflicts occurred, so the slices were not disjoint.',
      '  This run measured contention, not uncontended throughput. Do not record it.',
      '',
    );
  }

  lines.push('  Read dropped_iterations and http_req_failed before the rate above.', '');

  const out = { stdout: lines.join('\n') };

  // Raw evidence, written only when asked for, so a rehearsal cannot overwrite
  // a recorded measurement. Credentials stripped first — see above.
  if (__ENV.SUMMARY_OUT) {
    out[__ENV.SUMMARY_OUT] = JSON.stringify(withoutCredentials(data), null, 2);
  }

  return out;
}
