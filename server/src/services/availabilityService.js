import { pool } from '../db/pool.js';
import { redis } from '../db/redis.js';
import { isId } from './catalogService.js';
import { holdKey } from './holdService.js';

// This module is the only thing that answers "is this seat taken" — booked in
// Postgres or held in Redis, merged here and nowhere else (PLAN.md 4.3).
// holdService owns holds; it does not own this answer, which is why what it
// exports to this file is a key format rather than an availability read.

// A seat is unavailable if some non-cancelled booking claims it for this show.
// EXISTS rather than a join to booking_seats on purpose: until the booking
// phase adds its unique constraint, the same seat can legitimately appear on
// more than one booking row, and a join would emit that seat twice.
// One SQL text, two shapes. The scoped variant adds a single predicate so the
// broadcast path (Module 6.3) can ask about the seats that just changed instead
// of re-reading a whole screen on every hold. Built from one template rather
// than written twice: two hand-maintained copies of this query would be two
// answers to "is this seat taken", which is the thing CLAUDE.md §10 forbids.
function seatsForShowQuery({ scoped }) {
  return `
  select
    se.id,
    se.row_label,
    se.seat_number,
    se.tier,
    p.price_paise,
    case
      when exists (
        select 1
        from booking_seats bs
        join bookings b on b.id = bs.booking_id
        where bs.show_id = sh.id
          and bs.seat_id = se.id
          and b.status <> 'cancelled'
      ) then 'booked'
      else 'available'
    end as status
  from shows sh
  join seats se on se.screen_id = sh.screen_id
  left join show_prices p on p.show_id = sh.id and p.tier = se.tier
  where sh.id = $1
    ${scoped ? 'and se.id = any($2::bigint[])' : ''}
  order by se.row_label, se.seat_number
`;
}

const SEATS_FOR_SHOW = seatsForShowQuery({ scoped: false });
const SEATS_FOR_SHOW_SCOPED = seatsForShowQuery({ scoped: true });

function toSeats(rows) {
  return rows.map((row) => ({
    id: String(row.id),
    row_label: row.row_label,
    seat_number: row.seat_number,
    tier: row.tier,
    price_paise: row.price_paise,
    status: row.status,
  }));
}

// status is a string rather than a boolean, which is what lets 'held' join
// 'available' and 'booked' without changing the response shape.
//
// forUserId, when given, is the viewer. Their own holds are reported as
// available: a hold exists so that the person who took it can go on to book
// those seats, and reporting it back to them as unavailable would make it
// block the very thing it was taken for. Everyone else sees 'held'.
export async function getSeatStatus(showId, { forUserId } = {}) {
  if (!isId(showId)) return [];

  const { rows } = await pool.query(SEATS_FOR_SHOW, [showId]);

  return mergeHolds(showId, toSeats(rows), forUserId);
}

/**
 * Module 6.3. The same answer, for named seats only.
 *
 * This exists so a broadcast can describe the seats that actually changed. It
 * is the same SQL and the same hold merge as getSeatStatus — deliberately, and
 * this is the point: the alternative was inferring status at the call site
 * ("a hold was released, so the seat is available"), which is wrong the moment
 * the seat is also booked.
 *
 * Called with no forUserId by the broadcast path, so the answer is
 * viewer-agnostic: a hold reads 'held' to everybody, including its owner. The
 * client is what knows its own holds, and ignores those messages.
 */
export async function getSeatStatusFor(showId, seatIds, { forUserId } = {}) {
  if (!isId(showId)) return [];

  const ids = [...new Set(seatIds.map(String))].filter(isId);
  if (ids.length === 0) return [];

  const { rows } = await pool.query(SEATS_FOR_SHOW_SCOPED, [showId, ids]);

  return mergeHolds(showId, toSeats(rows), forUserId);
}

// One MGET over the seats Postgres just returned — a read of keys already
// known, not a scan of the keyspace. Booked wins over held: a sold seat does
// not become less sold because someone is holding it.
async function mergeHolds(showId, seats, forUserId) {
  if (seats.length === 0) return seats;

  // Degrade, do not fail. A seat map that renders without hold shading is far
  // better than no seat map, and holds were never the guarantee — the Phase 2.4
  // unique constraint still makes every seat sell exactly once. The write path
  // in holdService fails closed; this read path does not, and BACKLOG.md
  // records Redis as a hard dependency of holds themselves.
  if (!redis?.isReady) {
    console.error('availability: Redis unavailable, seat holds not merged');
    return seats;
  }

  let owners;
  try {
    owners = await redis.mGet(seats.map((seat) => holdKey(showId, seat.id)));
  } catch (err) {
    console.error('availability: hold lookup failed, holds not merged', err);
    return seats;
  }

  const viewer = forUserId === undefined || forUserId === null ? null : String(forUserId);

  return seats.map((seat, i) => {
    const owner = owners[i];

    if (seat.status !== 'available' || !owner) return seat;
    if (viewer && owner === viewer) return seat;

    return { ...seat, status: 'held' };
  });
}
