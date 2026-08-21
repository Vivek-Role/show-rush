// Phase 6.4 — the broadcast generator.
//
// Virtual users hold and release seats on one show, over and over, so the
// server emits a known, sustained stream of seat-status broadcasts. It exists
// to load the *client*: the number Module 6.4 records is measured in a browser
// tab watching that show, not here.
//
// This script books nothing and pays for nothing. It touches holds only, which
// are Redis keys with a TTL — nothing it does outlives HOLD_TTL_SECONDS, and
// nothing it does can double-sell a seat.
//
// It is not a benchmark of the server, and no number from its own output should
// be quoted as one. What it reports is how many broadcasts it caused, so the
// browser-side count has a denominator.
//
// Run it against a local server and a local Postgres/Redis. Never against Neon
// or Render — see loadtest/README.md.

import http from 'k6/http';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const SHOW_ID = __ENV.SHOW_ID || '1';
const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || '30s';
const EMAIL = __ENV.EMAIL || 'demo@show-rush.dev';
const PASSWORD = __ENV.PASSWORD || 'demo-password';

// Seats each VU cycles through. Small on purpose: the point is a high rate of
// status changes, not exercising the whole screen.
const SEATS_PER_VU = Number(__ENV.SEATS_PER_VU || 2);

// Pause between a hold and its release. Zero would be a tight loop measuring
// this laptop's HTTP stack; this produces a steady, describable rate instead.
const STEP_MS = Number(__ENV.STEP_MS || 200);

const held = new Counter('churn_hold_ok');
const heldConflict = new Counter('churn_hold_conflict');
const released = new Counter('churn_release_ok');
const failed = new Counter('churn_failed');

// Every seat change is one broadcast to the room. This is the denominator the
// browser's own counters are read against.
const broadcasts = new Counter('churn_broadcasts_caused');

http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  scenarios: {
    churn: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      gracefulStop: '10s',
    },
  },
  noConnectionReuse: false,
  thresholds: {
    'http_req_duration{endpoint:hold}': ['max>=0'],
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

  const map = http.get(`${BASE_URL}/api/shows/${SHOW_ID}/seatmap`);
  if (map.status !== 200) {
    throw new Error(`seatmap for show ${SHOW_ID} failed: ${map.status} ${map.body}`);
  }

  const free = map.json('seats').filter((seat) => seat.status === 'available');
  const wanted = VUS * SEATS_PER_VU;

  // Fail fast rather than measure nothing: with too few free seats the VUs
  // would spend the run colliding with each other instead of producing changes.
  if (free.length < wanted) {
    throw new Error(
      `show ${SHOW_ID} has ${free.length} available seats, needs ${wanted}; re-seed before measuring`,
    );
  }

  console.log(
    `churn: ${VUS} VUs × ${SEATS_PER_VU} seats for ${DURATION}, one broadcast per hold and per release`,
  );

  return { token: login.json('token'), seatIds: free.slice(0, wanted).map((seat) => String(seat.id)) };
}

export default function (data) {
  // Each VU owns its own slice of the seat list, so two VUs never contend for
  // the same seat. A 409 storm would produce fewer broadcasts, not more, and
  // would make the rate depend on luck.
  const start = (__VU - 1) * SEATS_PER_VU;
  const mine = data.seatIds.slice(start, start + SEATS_PER_VU);
  if (mine.length === 0) return;

  const auth = {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${data.token}` },
    tags: { endpoint: 'hold' },
  };

  const body = JSON.stringify({ seat_ids: mine });

  const take = http.post(`${BASE_URL}/api/shows/${SHOW_ID}/holds`, body, auth);

  if (take.status === 201) {
    held.add(1);
    broadcasts.add(1);
  } else if (take.status === 409) {
    heldConflict.add(1);
  } else {
    failed.add(1);
    return;
  }

  sleep(STEP_MS / 1000);

  const give = http.del(`${BASE_URL}/api/shows/${SHOW_ID}/holds`, body, auth);

  if (give.status === 200) {
    released.add(1);
    // A release only broadcasts what it actually released, so an already
    // expired hold causes none. At this cadence that is the rare case.
    broadcasts.add(1);
  } else {
    failed.add(1);
  }

  sleep(STEP_MS / 1000);
}

function value(data, metric, field) {
  const found = data.metrics[metric];
  if (!found || !found.values || found.values[field] === undefined) return 0;
  return found.values[field];
}

const REDACTED = '<redacted: bearer token, not part of the measurement>';

function withoutCredentials(summary) {
  if (!summary || !summary.setup_data) return summary;
  return { ...summary, setup_data: { ...summary.setup_data, token: REDACTED } };
}

export function handleSummary(data) {
  const caused = value(data, 'churn_broadcasts_caused', 'count');

  const lines = [
    '',
    'seat churn — broadcast generator for Module 6.4',
    `  base url             ${BASE_URL}`,
    `  show                 ${SHOW_ID}`,
    `  vus × seats          ${VUS} × ${SEATS_PER_VU}`,
    `  duration             ${DURATION}`,
    `  holds taken          ${value(data, 'churn_hold_ok', 'count')}`,
    `  holds refused (409)  ${value(data, 'churn_hold_conflict', 'count')}`,
    `  releases             ${value(data, 'churn_release_ok', 'count')}`,
    `  failures             ${value(data, 'churn_failed', 'count')}`,
    `  broadcasts caused    ${caused}`,
    '',
    '  The browser-side numbers are read from window.__srSeatUpdates in the tab',
    '  watching this show. This script reports only what it caused.',
    '',
  ];

  const out = { stdout: lines.join('\n') };

  if (__ENV.SUMMARY_OUT) {
    out[__ENV.SUMMARY_OUT] = JSON.stringify(withoutCredentials(data), null, 2);
  }

  return out;
}
