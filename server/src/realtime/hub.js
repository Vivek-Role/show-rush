import { WebSocketServer } from 'ws';
import { config } from '../config/env.js';
import { getSeatStatusFor } from '../services/availabilityService.js';
import { getShowWithScreen } from '../services/catalogService.js';

// Phase 6.3 — seat status pushed to the people looking at that show.
//
// One room per show, server to client only. There is no join message, no
// subscribe protocol and no client-to-server anything: the show is fixed at
// upgrade time from the query string, which leaves nothing for a connected
// socket to ask for and nothing to abuse.
//
// What travels over it comes from availabilityService and nowhere else. The
// tempting shortcut — "a hold was released, so broadcast 'available'" — is
// wrong whenever the seat is also booked, and it would be the second
// seat-status path CLAUDE.md §10 exists to prevent.
//
// Single instance only. A second Node process would broadcast to its own
// sockets and nobody else's; Redis pub/sub fan-out is BACKLOG.md P2, and this
// is already a stated limitation of the build rather than a surprise.

const PATH = '/ws';

// Half-open sockets — a laptop lid closing, a phone losing signal — are not
// closed by TCP in any useful time. Without this they accumulate as rooms that
// never empty.
const HEARTBEAT_MS = 30000;

// A client sends nothing, so anything arriving is either a bug or an attempt.
// 1 KiB is far more than the zero bytes a well-behaved client sends.
const MAX_PAYLOAD = 1024;

/** showId -> Set<WebSocket> */
const rooms = new Map();

let wss = null;
let heartbeat = null;

function join(showId, socket) {
  const room = rooms.get(showId) ?? new Set();
  room.add(socket);
  rooms.set(showId, room);
}

function leave(showId, socket) {
  const room = rooms.get(showId);
  if (!room) return;

  room.delete(socket);

  // An empty room is a leak if it is kept: one Map entry per show anybody has
  // ever looked at.
  if (room.size === 0) rooms.delete(showId);
}

// CORS does not apply to WebSocket upgrades, so the browser will happily open
// one from any page. This is the only same-origin check there is.
//
// An absent Origin is allowed: browsers always send one, so an attacker's page
// is always checked, while curl and a load-test client send none. That is the
// same reasoning middleware/auth.js uses to exempt bearer tokens from the CSRF
// header — a request a browser cannot forge carries its own proof of intent.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!config.clientOrigin) return true;
  return origin === config.clientOrigin;
}

function refuse(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Attach to the existing HTTP server. One port, one process — a second listener
 * would be a second thing to configure, deploy and get wrong.
 */
export function attachSeatEvents(server) {
  if (wss) return;

  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on('upgrade', async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return refuse(socket, 400, 'Bad Request');
    }

    // Anything that is not this path is not ours. Destroying rather than
    // ignoring, because an unanswered upgrade leaves the socket hanging.
    if (url.pathname !== PATH) {
      return refuse(socket, 404, 'Not Found');
    }

    if (!originAllowed(req)) {
      return refuse(socket, 403, 'Forbidden');
    }

    // Seat identity, and show identity, are Postgres's answer. An unknown show
    // is refused here rather than accepted into a room that can never receive
    // anything — the same 404 the seat map gives.
    const showId = url.searchParams.get('show_id') ?? '';
    let found;
    try {
      found = await getShowWithScreen(showId);
    } catch {
      return refuse(socket, 503, 'Service Unavailable');
    }

    if (!found) {
      return refuse(socket, 404, 'Not Found');
    }

    const room = String(found.show.id);

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.showId = room;

      join(room, ws);

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      // Server to client only. A frame arriving here is ignored on purpose:
      // there is no message this connection accepts, so there is no parser to
      // get wrong.
      ws.on('message', () => {});

      ws.on('close', () => leave(room, ws));
      ws.on('error', () => leave(room, ws));

      ws.send(
        JSON.stringify({
          type: 'hello',
          show_id: room,
          heartbeat_seconds: HEARTBEAT_MS / 1000,
        }),
      );
    });
  });

  heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const ws of room) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, HEARTBEAT_MS);

  heartbeat.unref?.();

  console.log(`seat events: websocket on ${PATH}?show_id=<id>`);
}

/**
 * Tell everyone watching this show what these seats now are.
 *
 * Best effort in the strict sense — this is called after a hold, a booking and
 * a payment, and none of those may fail because a socket did. Every caller
 * fires it without awaiting, and everything below is caught here.
 *
 * The read is skipped entirely when nobody is watching, so an unobserved show
 * costs one Map lookup rather than a query per hold.
 */
export async function broadcastSeats(showId, seatIds) {
  try {
    const room = rooms.get(String(showId));
    if (!room || room.size === 0) return;
    if (!seatIds || seatIds.length === 0) return;

    // Viewer-agnostic on purpose: no forUserId. One read answers the whole
    // room, and the client is what knows which holds are its own.
    const seats = await getSeatStatusFor(showId, seatIds);
    if (seats.length === 0) return;

    const message = JSON.stringify({
      type: 'seats',
      show_id: String(showId),
      seats: seats.map((seat) => ({ id: seat.id, status: seat.status })),
      at: new Date().toISOString(),
    });

    for (const ws of room) {
      // OPEN only. Sending to a socket mid-close throws, and one dead client
      // must not cost the rest of the room its update.
      if (ws.readyState === ws.OPEN) ws.send(message);
    }
  } catch (err) {
    console.error(`seat events: broadcast failed for show ${showId}`, err);
  }
}

export async function closeSeatEvents() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }

  if (!wss) return;

  for (const room of rooms.values()) {
    for (const ws of room) ws.close(1001, 'server shutting down');
  }
  rooms.clear();

  await new Promise((resolve) => wss.close(resolve));
  wss = null;
}
