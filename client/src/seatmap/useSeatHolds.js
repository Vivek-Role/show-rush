import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchHoldTtl, holdSeats, releaseSeats } from '../api/holds.js';

// Hold state and the countdown, and no rendering — the same split Module 3.3
// established for selection.
//
// The countdown is seeded from the server's TTL and never from Date.now(). A
// client clock can be wrong by minutes, and a countdown computed against a
// local deadline would confidently show a hold that the server let go of long
// ago. The number here comes from Redis, ticks down locally between answers,
// and is re-read from the server whenever the tab has been away.

const STORAGE_PREFIX = 'show-rush:holds:';

// sessionStorage, not localStorage: a hold belongs to this tab's visit. It is a
// list of seat ids to *ask about* after a reload — never a claim in itself. The
// server is asked to confirm every one of them before anything is restored.
function storageKey(showId) {
  return `${STORAGE_PREFIX}${showId}`;
}

function readStored(showId) {
  try {
    const raw = sessionStorage.getItem(storageKey(showId));
    const ids = raw ? JSON.parse(raw) : null;
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  } catch {
    // A private-mode browser or corrupt entry means no restore, not a crash.
    return [];
  }
}

function writeStored(showId, ids) {
  try {
    if (ids.length === 0) sessionStorage.removeItem(storageKey(showId));
    else sessionStorage.setItem(storageKey(showId), JSON.stringify(ids));
  } catch {
    // Persistence is a convenience. Losing it costs a restore, nothing more.
  }
}

export function useSeatHolds({ showId, enabled, onExpire }) {
  const [heldIds, setHeldIds] = useState([]);
  const [secondsLeft, setSecondsLeft] = useState(null);

  // BACKLOG.md P3 — the countdown is anchored, not accumulated.
  //
  // It used to reach the next number by subtracting one from the last one, once
  // per setTimeout. Every timer fires a little late, and subtraction keeps the
  // error: a minute of one-second timeouts on a busy main thread finishes
  // visibly behind the server, and always in the direction that flatters the
  // client — showing time the visitor does not have.
  //
  // Instead the server's answer is pinned to a reading of the monotonic clock,
  // and every tick recomputes the remainder from that pair. A late timer now
  // costs a skipped number rather than a permanent offset.
  //
  // performance.now(), never Date.now(): it cannot be moved by NTP, by the user
  // changing the clock, or by a daylight-saving jump mid-hold.
  const anchorRef = useRef(null);

  const remainingFromAnchor = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return null;

    const elapsed = (performance.now() - anchor.at) / 1000;
    return Math.max(0, Math.ceil(anchor.seconds - elapsed));
  }, []);

  // The one place a countdown starts. Takes the server's seconds, pins them to
  // now, and publishes the first value.
  const anchorSeconds = useCallback((seconds) => {
    anchorRef.current = { at: performance.now(), seconds };
    setSecondsLeft(Math.max(0, Math.ceil(seconds)));
  }, []);

  // Kept in a ref so the interval below never has to be torn down and rebuilt
  // when the callback identity changes — a countdown that restarts its own
  // timer every render is a countdown that never reaches zero.
  const expiryRef = useRef(onExpire);
  expiryRef.current = onExpire;

  const heldRef = useRef(heldIds);
  heldRef.current = heldIds;

  const remember = useCallback(
    (ids) => {
      setHeldIds(ids);
      writeStored(showId, ids);
    },
    [showId],
  );

  const forget = useCallback(() => {
    anchorRef.current = null;
    setSecondsLeft(null);
    remember([]);
  }, [remember]);

  // One second at a time, from whatever the server last said. Reaching zero
  // stops the timer and tells the page, which clears the selection — the seats
  // are genuinely gone by then, so the message has to be plain.
  useEffect(() => {
    if (secondsLeft === null) return undefined;

    if (secondsLeft <= 0) {
      anchorRef.current = null;
      writeStored(showId, []);
      setHeldIds([]);
      expiryRef.current?.();
      setSecondsLeft(null);
      return undefined;
    }

    // Recomputed from the anchor rather than decremented, so a late or coalesced
    // timer cannot make the display drift away from the server's answer.
    const timer = setTimeout(() => {
      const remaining = remainingFromAnchor();
      if (remaining !== null) setSecondsLeft(remaining);
    }, 1000);

    return () => clearTimeout(timer);
  }, [secondsLeft, showId, remainingFromAnchor]);

  // Ask the server what is actually left. Returns the seats it confirms, so the
  // caller can reconcile a selection against them.
  const resync = useCallback(
    async (ids) => {
      const asking = ids ?? heldRef.current;
      if (!enabled || asking.length === 0) return [];

      try {
        const payload = await fetchHoldTtl({ showId, seatIds: asking });
        const holds = payload?.holds ?? [];

        if (holds.length === 0) {
          forget();
          return [];
        }

        const confirmed = holds.map((hold) => hold.seat_id);
        remember(confirmed);

        // The earliest expiry governs: the countdown has to be true for every
        // seat it covers, not for the luckiest one. Re-anchored here, which is
        // what makes a resync — after a refresh, or after the tab was hidden —
        // correct rather than merely fresher.
        anchorSeconds(Math.min(...holds.map((hold) => hold.ttl_seconds)));

        return confirmed;
      } catch {
        // A failed re-read is not an expiry. Leave the countdown running and
        // let it, or the next answer, decide.
        return heldRef.current;
      }
    },
    [enabled, showId, forget, remember],
  );

  // Survives a refresh: the seat ids come back from sessionStorage, but their
  // validity comes from the server. Anything it does not confirm is dropped.
  const restore = useCallback(async () => {
    const stored = readStored(showId);
    if (!enabled || stored.length === 0) {
      if (stored.length > 0) writeStored(showId, []);
      return [];
    }
    return resync(stored);
  }, [enabled, showId, resync]);

  // A background tab throttles timers, so the local count drifts behind the
  // server. Coming back into view re-reads the real number rather than
  // trusting how many ticks the browser felt like delivering.
  useEffect(() => {
    if (!enabled) return undefined;

    const onVisible = () => {
      if (document.visibilityState === 'visible' && heldRef.current.length > 0) void resync();
    };

    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled, resync]);

  const hold = useCallback(
    async (seatIds) => {
      if (!enabled) return { ok: true };

      try {
        const payload = await holdSeats({ showId, seatIds });
        remember([...new Set([...heldRef.current, ...seatIds])]);

        // Every hold in a request is created together, so the newest TTL is the
        // full window; the earliest existing one still governs the display.
        // Compared against the live remainder, not the last rendered number,
        // so a stale render cannot extend the countdown.
        const current = remainingFromAnchor();
        anchorSeconds(
          current === null
            ? payload.hold.ttl_seconds
            : Math.min(current, payload.hold.ttl_seconds),
        );

        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          code: err.code,
          message:
            err.code === 'SEATS_HELD'
              ? 'Someone else is holding that seat right now. The map has been refreshed.'
              : err.code === 'HOLDS_UNAVAILABLE'
                ? 'Seat holds are unavailable at the moment. Try again shortly.'
                : 'That seat could not be held. Nothing has been reserved.',
        };
      }
    },
    [enabled, showId, remember],
  );

  const release = useCallback(
    async (seatIds) => {
      const dropped = new Set(seatIds);
      const remaining = heldRef.current.filter((id) => !dropped.has(id));

      // Local state first: letting a seat go must feel immediate, and the
      // server call below cannot fail in a way that makes the seat theirs again.
      remember(remaining);

      // The anchor goes with the display. Leaving it behind would let the next
      // hold compare its TTL against a countdown for seats nobody holds.
      if (remaining.length === 0) {
        anchorRef.current = null;
        setSecondsLeft(null);
      }

      if (!enabled) return;

      try {
        await releaseSeats({ showId, seatIds });
      } catch {
        // Best effort, exactly as on the server: an unreleased hold expires at
        // its TTL. Reporting it would only offer the user a button that does
        // nothing they can act on.
      }
    },
    [enabled, showId, remember],
  );

  const releaseAll = useCallback(async () => {
    const all = heldRef.current;
    if (all.length > 0) await release(all);
  }, [release]);

  return { heldIds, secondsLeft, hold, release, releaseAll, restore, resync };
}
