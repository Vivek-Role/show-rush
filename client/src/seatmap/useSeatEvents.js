import { useEffect, useRef } from 'react';
import { seatEventsUrl } from '../api/client.js';

// Modules 6.3 and 6.4 — live seat status, and the batching that keeps it cheap.
//
// The same split the rest of the seat map keeps: connection and buffering live
// here, rendering lives in the component. No JSX, no seat state — the page owns
// the seats, and this hands it patches to apply.
//
// A message is never trusted to be complete. The socket carries changes, the
// REST payload carries truth, and any gap in the former is closed by re-reading
// the latter — which is exactly what a reconnect does.

// Module 6.4. Both paths ship permanently; see client/.env.example.
const MODE = import.meta.env.VITE_SEAT_UPDATE_MODE === 'immediate' ? 'immediate' : 'batched';

// Reconnect backoff. Starts fast because the common cause is a server restart
// in development, and gives up climbing at fifteen seconds because a tab left
// open overnight should not hammer a server that is down.
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 15000;

// rAF does not fire in a hidden tab, so a buffered update would sit there until
// the tab came back — and the buffer would grow the whole time. This is the
// fallback clock for that case, not a second batching strategy.
const HIDDEN_FLUSH_MS = 1000;

// Module 6.4's measurement surface. Counters only, read from the console during
// the recorded run; nothing renders them and nothing branches on them.
function counters() {
  if (typeof window === 'undefined') return null;

  window.__srSeatUpdates ??= { mode: MODE, messages: 0, seatUpdates: 0, flushes: 0 };
  return window.__srSeatUpdates;
}

export function useSeatEvents({ showId, enabled = true, onSeats, onResync }) {
  // Kept in refs so a changing callback identity never tears down the socket.
  // A connection that reconnects on every render is not a connection.
  const seatsRef = useRef(onSeats);
  seatsRef.current = onSeats;

  const resyncRef = useRef(onResync);
  resyncRef.current = onResync;

  useEffect(() => {
    if (!enabled || !showId) return undefined;

    let socket = null;
    let backoff = BACKOFF_START_MS;
    let retry = null;
    let closed = false;

    // seatId -> status. A Map, so fifty changes to one seat in one frame
    // collapse to one entry rather than fifty applications of the same value.
    const buffer = new Map();
    let frame = null;
    let hiddenTimer = null;

    function flush() {
      frame = null;
      hiddenTimer = null;
      if (buffer.size === 0) return;

      const batch = new Map(buffer);
      buffer.clear();

      const stats = counters();
      if (stats) stats.flushes += 1;

      seatsRef.current?.(batch);
    }

    function schedule() {
      if (MODE === 'immediate') {
        flush();
        return;
      }

      // Hidden tab: rAF will not run, so the timeout is what keeps the buffer
      // bounded. Visible: one frame, one flush, however many messages arrived.
      if (document.visibilityState === 'hidden') {
        hiddenTimer ??= setTimeout(flush, HIDDEN_FLUSH_MS);
        return;
      }

      frame ??= requestAnimationFrame(flush);
    }

    function onMessage(event) {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        // A frame this client cannot read is not a reason to drop the socket.
        return;
      }

      if (payload?.type !== 'seats' || !Array.isArray(payload.seats)) return;

      const stats = counters();
      if (stats) {
        stats.messages += 1;
        stats.seatUpdates += payload.seats.length;
      }

      for (const seat of payload.seats) {
        if (seat?.id) buffer.set(String(seat.id), seat.status);
      }

      schedule();
    }

    function connect() {
      if (closed) return;

      let url;
      try {
        url = seatEventsUrl(showId);
      } catch {
        // A misconfigured base URL is a build problem, and the seat map still
        // works without live updates. Reported once, not retried forever.
        console.error('seat events: could not build a socket URL');
        return;
      }

      socket = new WebSocket(url);

      socket.addEventListener('open', () => {
        // Anything that changed while the socket was down was never delivered.
        // The REST payload is the recovery — this is why a reconnect refetches
        // rather than assuming it can carry on where it left off.
        if (backoff !== BACKOFF_START_MS) resyncRef.current?.();
        backoff = BACKOFF_START_MS;
      });

      socket.addEventListener('message', onMessage);

      socket.addEventListener('close', () => {
        if (closed) return;

        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      });

      // 'error' is always followed by 'close', so the reconnect is handled in
      // one place. Swallowed here to keep a failed connection out of the
      // console on every retry.
      socket.addEventListener('error', () => {});
    }

    // Coming back to a tab that was away: flush whatever the fallback clock has
    // not yet taken, then let the page decide whether to re-read the map.
    function onVisible() {
      if (document.visibilityState === 'visible') flush();
    }

    document.addEventListener('visibilitychange', onVisible);
    connect();

    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (retry) clearTimeout(retry);
      if (frame) cancelAnimationFrame(frame);
      if (hiddenTimer) clearTimeout(hiddenTimer);
      buffer.clear();
      socket?.close();
    };
  }, [showId, enabled]);
}
