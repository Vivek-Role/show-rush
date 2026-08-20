-- Phase 2.2 — the counting method for the seat-contention run.
--
-- Run against the database the load test just hit, immediately after the run.
-- This is the measurement; seat-contention.js only produces the requests.
--
--   docker exec -i showrush-postgres \
--     psql -U showrush -d <database> -f - < loadtest/count-double-bookings.sql
--
-- The `status <> 'cancelled'` filter matches availabilityService exactly, so
-- these numbers mean "seats the system considers sold twice" rather than
-- "duplicate rows" — the same definition the application uses when it decides
-- whether a seat is free.

\echo
\echo == seats claimed more than once ==

select
  bs.show_id,
  bs.seat_id,
  count(*) as claims
from booking_seats bs
join bookings b on b.id = bs.booking_id
where b.status <> 'cancelled'
group by bs.show_id, bs.seat_id
having count(*) > 1
order by claims desc, bs.show_id, bs.seat_id;

\echo
\echo == the headline number: rows that should not exist ==

select coalesce(sum(claims - 1), 0) as double_bookings
from (
  select count(*) as claims
  from booking_seats bs
  join bookings b on b.id = bs.booking_id
  where b.status <> 'cancelled'
  group by bs.show_id, bs.seat_id
) t
where claims > 1;

\echo
\echo == context: did the load actually reach the database? ==

select
  (select count(*) from bookings)                    as bookings,
  (select count(*) from booking_seats)               as booking_seat_rows,
  (select count(distinct (show_id, seat_id))
     from booking_seats)                             as distinct_seats_claimed;

\echo
\echo == the constraint that decides, if any ==

select
  indexname,
  indexdef
from pg_indexes
where tablename = 'booking_seats'
order by indexname;
