import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { redis } from '../db/redis.js';
import { HttpError } from '../lib/http-error.js';

// BACKLOG.md P2 — virtual waiting room: a queue with a position, and a
// controlled admission rate, for a show that would otherwise be stormed.
//
// WHAT IT PROTECTS. Nothing about correctness: the Phase 2.4 unique constraint
// still makes a seat sell exactly once, and it would do so with ten thousand
// people in the room. This protects *capacity* — it decides how many people are
// allowed to start competing for seats per minute, so the hold path sees a
// steady arrival rate instead of a spike.
//
// ADMISSION IS COMPUTED, NOT TICKED. There is no background job advancing a
// cursor. The queue records when it opened, tickets are numbered by INCR, and
// how many have been admitted at any instant is arithmetic over the elapsed
// time. A job would drift, would need a leader once several instances run, and
// would be one more thing to start and stop; this needs none of that and gives
// the same answer on every instance without coordination.
//
// OFF BY DEFAULT, per show. WAITING_ROOM_SHOWS is an explicit list, so enabling
// the room is a deliberate act for a named show — and every existing benchmark,
// test and demo keeps behaving exactly as it did.

const KEY_PREFIX = 'waitingroom';

function startKey(showId) {
  return `${KEY_PREFIX}:start:${showId}`;
}

function seqKey(showId) {
  return `${KEY_PREFIX}:seq:${showId}`;
}

function ticketKey(showId, token) {
  return `${KEY_PREFIX}:ticket:${showId}:${token}`;
}

/**
 * Whether the room is switched on for this show.
 *
 * A list rather than a boolean: a waiting room on every show would throttle the
 * quiet ones for nothing, and the whole point is that it applies to the show
 * everyone is trying to reach at once.
 */
export function waitingRoomEnabled(showId) {
  return config.waitingRoomShows.includes(String(showId));
}

/**
 * How many tickets have been admitted by `nowMs`.
 *
 * Pure, and the heart of the feature. The initial allowance is admitted at
 * once — without it the first visitor to a freshly opened queue would wait for
 * the rate to tick round, which is a queue for a show nobody is queuing for.
 */
export function admittedBy({ startedAtMs, nowMs, ratePerMinute, initialAdmit }) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return 0;

  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  const admittedSinceOpen = Math.floor((elapsedMs / 60000) * ratePerMinute);

  return initialAdmit + admittedSinceOpen;
}

/**
 * Places still ahead of this ticket. 0 means admitted.
 *
 * Ticket numbers are 1-based, so ticket 1 is admitted the moment one admission
 * has been granted.
 */
export function positionOf(ticketNumber, admitted) {
  return Math.max(0, ticketNumber - admitted);
}

/**
 * Roughly how long that position will take, in seconds.
 *
 * Reported as an estimate and nothing more: it assumes the rate holds and that
 * nobody ahead abandons the queue, and both are guesses. Rounded up, because a
 * wait that finishes early is a better surprise than one that runs over.
 */
export function etaSeconds(position, ratePerMinute) {
  if (position <= 0) return 0;
  if (ratePerMinute <= 0) return null;

  return Math.ceil((position / ratePerMinute) * 60);
}

// The room needs Redis to count anything at all. Unlike the hold path this
// fails OPEN: if the queue cannot be reached the visitor is let through rather
// than shut out, because the room is a capacity control and holds already fail
// closed on their own. A broken throttle must not become a broken checkout.
function client() {
  return redis?.isReady ? redis : null;
}

function describe({ ticketNumber, admitted, ratePerMinute, token }) {
  const position = positionOf(ticketNumber, admitted);

  return {
    token,
    ticket: ticketNumber,
    position,
    admitted: position === 0,
    eta_seconds: etaSeconds(position, ratePerMinute),
  };
}

/**
 * Read the queue's opening instant, creating it if this is the first caller.
 *
 * SET NX: several instances can race here and exactly one wins, which is what
 * keeps every instance computing admissions from the same origin.
 */
async function openedAt(conn, showId) {
  const key = startKey(showId);
  const now = Date.now();

  const created = await conn.set(key, String(now), { NX: true });
  if (created) return now;

  const existing = await conn.get(key);
  const parsed = Number(existing);

  return Number.isFinite(parsed) ? parsed : now;
}

/**
 * Join the queue, or return the ticket this token already holds.
 *
 * Idempotent on the token so a client that retries — or reloads — keeps its
 * place instead of going to the back of the queue for having a flaky network.
 */
export async function joinQueue({ showId, token }) {
  const conn = client();
  const ratePerMinute = config.waitingRoomRatePerMinute;

  // No Redis: the room cannot count, so it does not gate. Reported as admitted
  // because that is exactly what happens next.
  if (!conn) {
    return { token: token ?? randomUUID(), ticket: 0, position: 0, admitted: true, eta_seconds: 0 };
  }

  const startedAtMs = await openedAt(conn, showId);

  if (token) {
    const existing = await conn.get(ticketKey(showId, token));

    if (existing !== null) {
      const ticketNumber = Number(existing);
      const admitted = admittedBy({
        startedAtMs,
        nowMs: Date.now(),
        ratePerMinute,
        initialAdmit: config.waitingRoomInitialAdmit,
      });

      return describe({ ticketNumber, admitted, ratePerMinute, token });
    }
  }

  const issued = token ?? randomUUID();
  const ticketNumber = await conn.incr(seqKey(showId));

  // The ticket outlives a long wait but not the visitor's session. An expired
  // ticket is not an error — the holder simply joins again, at the back.
  await conn.set(ticketKey(showId, issued), String(ticketNumber), {
    EX: config.waitingRoomTicketTtlSeconds,
  });

  const admitted = admittedBy({
    startedAtMs,
    nowMs: Date.now(),
    ratePerMinute,
    initialAdmit: config.waitingRoomInitialAdmit,
  });

  return describe({ ticketNumber, admitted, ratePerMinute, token: issued });
}

/**
 * Where a ticket stands right now. Null when it is unknown or has expired.
 */
export async function ticketStatus({ showId, token }) {
  const conn = client();
  if (!conn) return { token, ticket: 0, position: 0, admitted: true, eta_seconds: 0 };
  if (!token) return null;

  const raw = await conn.get(ticketKey(showId, token));
  if (raw === null) return null;

  const startedAtMs = await openedAt(conn, showId);
  const admitted = admittedBy({
    startedAtMs,
    nowMs: Date.now(),
    ratePerMinute: config.waitingRoomRatePerMinute,
    initialAdmit: config.waitingRoomInitialAdmit,
  });

  return describe({
    ticketNumber: Number(raw),
    admitted,
    ratePerMinute: config.waitingRoomRatePerMinute,
    token,
  });
}

/**
 * Refuse anyone who has not reached the front. Used by the hold route.
 *
 * Throws rather than returning a boolean so the route reads like every other
 * refusal in this codebase, and so the two reasons — no ticket at all, and a
 * ticket still waiting — stay distinguishable by code.
 */
export async function requireAdmission({ showId, token }) {
  if (!waitingRoomEnabled(showId)) return;

  const status = await ticketStatus({ showId, token });

  if (!status) {
    throw new HttpError(
      403,
      'QUEUE_REQUIRED',
      'This show has a waiting room. Join the queue before holding seats.',
    );
  }

  if (!status.admitted) {
    throw new HttpError(
      403,
      'QUEUE_WAITING',
      `You are number ${status.position} in the queue for this show.`,
    );
  }
}
