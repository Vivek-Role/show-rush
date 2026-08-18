import { pool } from '../db/pool.js';
import { isId } from './catalogService.js';

// This module is the only thing that answers "is this seat taken". Phase 4.3
// adds Redis holds by extending the query below, and holdService must not
// grow a second availability read — one query path, not two.

// A seat is unavailable if some non-cancelled booking claims it for this show.
// EXISTS rather than a join to booking_seats on purpose: until the booking
// phase adds its unique constraint, the same seat can legitimately appear on
// more than one booking row, and a join would emit that seat twice.
const SEATS_FOR_SHOW = `
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
  order by se.row_label, se.seat_number
`;

// status is a string rather than a boolean because Phase 4.3 adds 'held' to
// the set without changing the response shape.
export async function getSeatStatus(showId) {
  if (!isId(showId)) return [];

  const { rows } = await pool.query(SEATS_FOR_SHOW, [showId]);

  return rows.map((row) => ({
    id: String(row.id),
    row_label: row.row_label,
    seat_number: row.seat_number,
    tier: row.tier,
    price_paise: row.price_paise,
    status: row.status,
  }));
}
