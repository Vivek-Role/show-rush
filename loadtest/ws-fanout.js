// Phase 7.3a — WebSocket fan-out, as an instrument.
//
// This is NOT one of PLAN.md 7.1's four claims and it reports no performance
// number. It exists to put a known number of live sockets on the server so that
// something else can be observed: resident memory, sampled from outside the
// process, and the cost the broadcast path adds to a hold.
//
// It opens SOCKETS connections to /ws?show_id=<id>, holds them open for
// DURATION_MS, and closes them. What it reports is what it did — sockets
// opened, frames received, sockets closed — so that an externally sampled
// memory figure has a denominator it can be trusted against.
//
// IT CANNOT MEASURE SERVER MEMORY. A client has no view of a server's RSS, and
// nothing here should ever be quoted as one. The memory sampling procedure is
// in loadtest/README.md and reads /proc/<pid>/status directly.
//
// The hub is server-to-client only: there is no join message and no subscribe
// protocol, the show is fixed at upgrade time from the query string, and any
// frame arriving at the server is ignored. So this script sends nothing after
// the handshake — there is nothing it could send.
//
// Run it against a local server. Never against Neon or Render — see
// loadtest/README.md.

import { WebSocket } from 'k6/websockets';
import { Counter } from 'k6/metrics';

// ws:// not http:// — this is the only script in loadtest/ that needs the
// WebSocket scheme, and deriving it from BASE_URL would silently produce
// wss:// nonsense if anyone ever pointed BASE_URL somewhere with TLS.
const WS_URL = __ENV.WS_URL || 'ws://localhost:3000';
const SHOW_ID = __ENV.SHOW_ID || '1';

// One socket per VU, held for the whole iteration. SOCKETS is the honest name
// for what this controls, so it is not called VUS.
const SOCKETS = Number(__ENV.SOCKETS || 100);
const DURATION_MS = Number(__ENV.DURATION_MS || 60000);

const opened = new Counter('ws_opened');
const hello = new Counter('ws_hello');
const seatFrames = new Counter('ws_seat_frames');
const seatUpdates = new Counter('ws_seat_updates');
const closed = new Counter('ws_closed');
const errors = new Counter('ws_error');
const unknownFrames = new Counter('ws_unknown_frame');

export const options = {
  scenarios: {
    fanout: {
      executor: 'per-vu-iterations',
      vus: SOCKETS,
      iterations: 1,
      // Comfortably past DURATION_MS so a slow open cannot truncate the hold.
      maxDuration: `${Math.ceil(DURATION_MS / 1000) + 60}s`,
      gracefulStop: '30s',
    },
  },
};

export default function () {
  const socket = new WebSocket(`${WS_URL}/ws?show_id=${SHOW_ID}`);

  socket.onopen = () => {
    opened.add(1);

    // Close from a timer rather than by blocking: the k6 WebSocket API is
    // event-driven, and the iteration stays alive while a timer is pending.
    setTimeout(() => socket.close(), DURATION_MS);
  };

  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      unknownFrames.add(1);
      return;
    }

    if (message.type === 'hello') {
      hello.add(1);
      return;
    }

    if (message.type === 'seats') {
      seatFrames.add(1);
      // One frame can carry many seats. Both numbers matter: frames is what the
      // socket cost, seats is what the room actually learned.
      seatUpdates.add(Array.isArray(message.seats) ? message.seats.length : 0);
      return;
    }

    unknownFrames.add(1);
  };

  socket.onclose = () => {
    closed.add(1);
  };

  // A refused upgrade arrives here, not as a thrown error. The hub answers 404
  // for an unknown show and 403 for a disallowed origin, and either would
  // otherwise look like a run that simply received nothing.
  socket.onerror = () => {
    errors.add(1);
  };
}

function value(data, metric, field) {
  const found = data.metrics[metric];
  if (!found || !found.values || found.values[field] === undefined) return 0;
  return found.values[field];
}

export function handleSummary(data) {
  const openedCount = value(data, 'ws_opened', 'count');
  const helloCount = value(data, 'ws_hello', 'count');

  const lines = [
    '',
    'websocket fan-out  (instrument — reports no performance number)',
    `  ws url               ${WS_URL}/ws?show_id=${SHOW_ID}`,
    `  sockets requested    ${SOCKETS}`,
    `  held for             ${DURATION_MS} ms`,
    '',
    `  iterations           ${value(data, 'iterations', 'count')}`,
    `  dropped_iterations   ${value(data, 'dropped_iterations', 'count')}`,
    '',
    `  sockets opened       ${openedCount}`,
    `  hello frames         ${helloCount}`,
    `  seats frames         ${value(data, 'ws_seat_frames', 'count')}`,
    `  seat updates carried ${value(data, 'ws_seat_updates', 'count')}`,
    `  sockets closed       ${value(data, 'ws_closed', 'count')}`,
    `  errors               ${value(data, 'ws_error', 'count')}`,
    `  unrecognised frames  ${value(data, 'ws_unknown_frame', 'count')}`,
    '',
  ];

  // The hub sends exactly one hello per accepted upgrade, so these two
  // disagreeing means some sockets were refused or dropped and the run did not
  // put SOCKETS connections on the server at all.
  if (openedCount !== SOCKETS || helloCount !== openedCount) {
    lines.push(
      `  WARNING: asked for ${SOCKETS} sockets, opened ${openedCount}, got ${helloCount} hellos.`,
      '  The server did not hold the intended number of connections.',
      '  Any memory figure sampled against this run is against the wrong denominator.',
      '',
    );
  }

  lines.push(
    '  This script cannot see server memory. Sample /proc/<pid>/status VmRSS',
    '  from outside the process — see loadtest/README.md.',
    '',
  );

  const out = { stdout: lines.join('\n') };

  // No setup() here, so there is no bearer token in the summary to redact:
  // the hub is unauthenticated by decision, matching the public seat map.
  if (__ENV.SUMMARY_OUT) {
    out[__ENV.SUMMARY_OUT] = JSON.stringify(data, null, 2);
  }

  return out;
}
