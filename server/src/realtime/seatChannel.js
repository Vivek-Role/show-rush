import { createSubscriber, redis } from '../db/redis.js';

// Phase 9 M3 — the wire between instances.
//
// Transport only. This file knows how to put a message on Redis and how to hand
// one back; it knows nothing about rooms, sockets or seat status. hub.js owns
// all of that, which is what keeps "who is watching" in one place.
//
// ONE CHANNEL, not one per show. Per-show channels would mean subscribing and
// unsubscribing as rooms open and close — more moving parts, and a race every
// time the last watcher of a show disconnects while a broadcast is in flight.
// The cost of one channel is that every instance sees every message and filters
// by show_id on receipt. At the scale this system is built for that is a Map
// lookup per instance per seat change, and it is the honest trade: simpler
// lifecycle, slightly more chatter.
//
// A SECOND CONNECTION IS REQUIRED, not preferred. A Redis client in subscribe
// mode cannot issue ordinary commands, and the client in db/redis.js is already
// serving hold SET/GET/MGET on the request path. Sharing one would break holds
// the moment this subscribed.

const CHANNEL = 'seats:updates';

let subscriber = null;
let subscribed = false;

/**
 * True when this instance can actually reach the other instances.
 *
 * hub.js uses it to decide whether a broadcast goes out over Redis or stays
 * local, so it must answer honestly about the connection rather than about
 * whether connect() was once called.
 */
export function seatChannelReady() {
  return Boolean(subscriber?.isReady) && subscribed && Boolean(redis?.isReady);
}

/**
 * Subscribe, and route every message to `onMessage`.
 *
 * Non-fatal by design, exactly like connectRedis(): an instance that cannot
 * reach the channel still serves HTTP, still holds seats, and still tells its
 * own sockets what changed. It simply cannot hear about the other instances —
 * which is the single-instance behaviour this build shipped with, so the
 * degraded mode is the one that was already verified.
 */
export async function connectSeatChannel(onMessage) {
  if (subscriber) return;

  subscriber = createSubscriber();
  if (!subscriber) {
    console.error('seat channel: REDIS_URL is not set, cross-instance fan-out is off');
    return;
  }

  // Without a listener an emitted error is fatal to the process. A channel that
  // drops must degrade to local-only, never take the server down.
  subscriber.on('error', () => {});

  try {
    await subscriber.connect();
    await subscriber.subscribe(CHANNEL, (raw) => {
      let payload;

      try {
        payload = JSON.parse(raw);
      } catch {
        // A frame this build cannot read is not a reason to tear down the
        // subscription. Ignored, exactly as the client ignores an unreadable
        // socket frame.
        return;
      }

      onMessage(payload);
    });

    subscribed = true;
    console.log(`seat channel: subscribed to ${CHANNEL}`);
  } catch (err) {
    console.error('seat channel: subscribe failed, falling back to local fan-out', err);
    subscribed = false;
  }
}

/**
 * Publish one seat-change message.
 *
 * Returns whether it went out, because the caller's fallback depends on the
 * answer: a message that was not published has not reached this instance's own
 * sockets either, and hub.js must then deliver it locally. Getting this return
 * value wrong in either direction produces the two failure modes that matter —
 * a silently dropped update, or the same update delivered twice.
 */
export async function publishSeats(message) {
  if (!seatChannelReady()) return false;

  try {
    await redis.publish(CHANNEL, JSON.stringify(message));
    return true;
  } catch (err) {
    console.error('seat channel: publish failed, falling back to local fan-out', err);
    return false;
  }
}

export async function closeSeatChannel() {
  if (!subscriber) return;

  const client = subscriber;
  subscriber = null;
  subscribed = false;

  try {
    if (client.isOpen) await client.unsubscribe(CHANNEL);
  } catch {
    // Shutting down; an unsubscribe that fails changes nothing.
  }

  await client.quit().catch(() => {});
}
