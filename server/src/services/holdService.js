import { redis } from '../db/redis.js';
import { HttpError } from '../lib/http-error.js';
import { isId } from './catalogService.js';

// Short-lived seat holds, PLAN.md 4.1. A hold is one Redis key with a TTL and
// nothing else: no index, no set per show, no second copy of who holds what.
//
// This module answers "who holds this one seat" and "how long has it got".
// It deliberately cannot answer "which seats of this show are held" —
// availabilityService owns seat-status truth (CLAUDE.md §10) and Module 4.3
// extends it. A listing here would be the second query path that rule exists
// to prevent.
//
// A hold is not a booking. It reserves nothing in Postgres, and the unique
// constraint from Phase 2.4 remains the only guarantee against a double sell.
// Holds exist so two people don't spend seven minutes on the same seat.

// PLAN.md fixes this at seven minutes. It is a constant, not configuration:
// the number is a product decision (documented in Phase 8.2), and making it
// tunable would let a deploy quietly change what a hold means.
export const HOLD_TTL_SECONDS = 420;

// One key per held seat. The show id is in the key because a seat belongs to a
// screen, and the same screen runs many shows — a hold is per showing, not per
// seat forever.
function holdKey(showId, seatId) {
  return `hold:${showId}:${seatId}`;
}

// The routes validate ids before they get here (lib/validate.js). This is the
// backstop that keeps an unvalidated caller from writing a key of its own
// choosing: without it, a seat id containing a colon addresses another seat's
// hold.
function assertIds(showId, seatIds) {
  if (!isId(showId)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'show_id must be an id');
  }
  if (!seatIds.every(isId)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'seat_ids must all be ids');
  }
}

// Fail closed. db/redis.js swallows connection errors so a down Redis degrades
// /health rather than killing the process, and node-redis queues commands
// issued before it is ready — so "the client exists" is not "the hold was
// taken". A hold that silently did not happen is a seat sold twice, which is
// strictly worse than an error. isReady, not isOpen: isOpen is already true
// while the socket is still connecting.
//
// BACKLOG.md records the consequence honestly: Redis is a hard dependency of
// the hold path.
function client() {
  if (!redis?.isReady) {
    throw new HttpError(503, 'HOLDS_UNAVAILABLE', 'Seat holds are temporarily unavailable');
  }
  return redis;
}

// Seat ids are bigint-shaped strings. String sort puts "10" before "2", which
// would silently destroy the ordering property below — the same comparator
// bookingService uses for its inserts, for the same reason.
function sortSeatIdsNumerically(seatIds) {
  return [...seatIds].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Lua scripts.
//
// Every state change below is one script over one key, because the alternative
// — read the owner, then act on it — is a race. Between the two round trips a
// hold can expire and be re-acquired by somebody else, and the second command
// then lands on a stranger's hold. It fails rarely, under exactly the load
// where it matters, which is what makes it dangerous rather than merely wrong.
// PLAN.md 4.1 requires the script form for release and extend; acquire needs
// it too, for the same-owner case.
// ---------------------------------------------------------------------------

// SET NX is the acquisition, exactly as PLAN.md specifies. The rest of the
// script exists only for the caller who already owns the seat: NX refuses even
// the current owner, so a client whose response was dropped could not retry
// against itself. Re-acquiring your own hold refreshes it and reports success.
//
// The GET comparison is what keeps this from being ownership theft: a key held
// by anybody else falls through to 0 untouched. Returns 1 acquired, 2
// refreshed (already ours), 0 held by another user.
const ACQUIRE_SCRIPT = `
  if redis.call('set', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then
    return 1
  end
  if redis.call('get', KEYS[1]) == ARGV[1] then
    redis.call('expire', KEYS[1], ARGV[2])
    return 2
  end
  return 0
`;

// Compare-and-delete. Never GET then DEL.
const RELEASE_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;

// Compare-and-expire. Never GET then EXPIRE.
const EXTEND_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('expire', KEYS[1], ARGV[2])
  end
  return 0
`;

function runScript(script, key, args) {
  return client().eval(script, { keys: [key], arguments: args });
}

/**
 * Acquire a hold on every seat, or none of them.
 *
 * Seats are taken in ascending numeric order so two overlapping requests for
 * overlapping seats contend in the same sequence — one loses a seat and gives
 * the rest back, rather than the two each holding half of what the other needs.
 *
 * All-or-nothing is a property of this function's result and its rollback, not
 * of Redis: there is no transaction across the keys. On a partial failure the
 * holds taken by *this call* are compare-and-deleted in reverse order on a
 * best-effort basis. If one of those deletes fails, that seat stays held until
 * its TTL expires — at most HOLD_TTL_SECONDS of a seat nobody can select. That
 * is the honest limit of the guarantee, and it is not covered up by a retry.
 *
 * Seats this user already held are refreshed, not created, so they are not
 * rolled back: they existed before the call and are still the user's own
 * afterwards. Deleting them would take away a hold the caller never asked to
 * give up.
 */
export async function acquireHolds({ showId, seatIds, userId }) {
  assertIds(showId, seatIds);

  const ordered = sortSeatIdsNumerically(seatIds);
  const owner = String(userId);
  const ttl = String(HOLD_TTL_SECONDS);
  const acquired = [];

  for (const seatId of ordered) {
    const result = await runScript(ACQUIRE_SCRIPT, holdKey(showId, seatId), [owner, ttl]);

    if (result === 0) {
      await rollback(showId, acquired, owner);
      return { ok: false, conflictSeatId: seatId, seatIds: ordered };
    }

    // Only newly created holds are rollback material — see above.
    if (result === 1) acquired.push(seatId);
  }

  return { ok: true, seatIds: ordered, ttlSeconds: HOLD_TTL_SECONDS };
}

// Reverse acquisition order, so the seat taken last is the first given back.
// Best effort in the strict sense: a throw here would replace a recoverable
// "that seat is taken" with a 500, and the TTL already bounds the damage.
async function rollback(showId, seatIds, owner) {
  for (const seatId of [...seatIds].reverse()) {
    try {
      await runScript(RELEASE_SCRIPT, holdKey(showId, seatId), [owner]);
    } catch {
      // Left to expire at TTL. Logged, never rethrown.
      console.error(`hold rollback failed for show ${showId} seat ${seatId}`);
    }
  }
}

/**
 * Release holds this user owns. Seats held by somebody else, and seats whose
 * hold has already expired, are left alone and simply not reported — neither
 * is an error, and both are ordinary under a TTL.
 */
export async function releaseHolds({ showId, seatIds, userId }) {
  assertIds(showId, seatIds);

  const owner = String(userId);
  const releasedSeatIds = [];

  for (const seatId of sortSeatIdsNumerically(seatIds)) {
    const deleted = await runScript(RELEASE_SCRIPT, holdKey(showId, seatId), [owner]);
    if (deleted === 1) releasedSeatIds.push(seatId);
  }

  return { releasedSeatIds };
}

/**
 * Extend the TTL of holds this user owns, back to the full HOLD_TTL_SECONDS.
 *
 * Reported as all-or-nothing, but never rolled back: shortening a hold that
 * was just extended successfully would give away a seat to fix a bookkeeping
 * inconsistency. A seat that could not be extended is one whose hold expired or
 * changed hands, and the caller has to be told which.
 */
export async function extendHolds({ showId, seatIds, userId }) {
  assertIds(showId, seatIds);

  const owner = String(userId);
  const ttl = String(HOLD_TTL_SECONDS);
  const extendedSeatIds = [];
  const missedSeatIds = [];

  for (const seatId of sortSeatIdsNumerically(seatIds)) {
    const extended = await runScript(EXTEND_SCRIPT, holdKey(showId, seatId), [owner, ttl]);
    if (extended === 1) extendedSeatIds.push(seatId);
    else missedSeatIds.push(seatId);
  }

  return {
    ok: missedSeatIds.length === 0,
    extendedSeatIds,
    missedSeatIds,
    ttlSeconds: HOLD_TTL_SECONDS,
  };
}

/**
 * Who holds this one seat, or null. A single-key read by a caller that already
 * knows the seat id — not a way to enumerate a show.
 */
export async function getHoldOwner({ showId, seatId }) {
  assertIds(showId, [seatId]);
  return client().get(holdKey(showId, seatId));
}

/**
 * Seconds left on this one seat's hold, or null when there is no hold.
 *
 * TTL replies -2 for a key that does not exist and -1 for a key with no expiry.
 * Every hold is written with EX, so -1 should be unreachable; both collapse to
 * null rather than leaking a sentinel to callers as if it were a duration.
 */
export async function getHoldTtl({ showId, seatId }) {
  assertIds(showId, [seatId]);

  const ttl = await client().ttl(holdKey(showId, seatId));
  return ttl >= 0 ? ttl : null;
}
