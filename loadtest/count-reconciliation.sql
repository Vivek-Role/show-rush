-- Phase 6.2 / 6.1 — what the sweep and the late-payment path actually did.
--
-- The scripts produce requests; this reports the result. Run it against the
-- local docker compose Postgres after a sweep:
--
--   docker exec -i showrush-postgres \
--     psql -U showrush -d showrush -f - < loadtest/count-reconciliation.sql

\echo '== booking status distribution'
select status, count(*) as bookings
  from bookings
 group by status
 order by status;

\echo ''
\echo '== seats released by the sweep'
select reason, count(*) as seats, count(distinct booking_id) as bookings
  from released_booking_seats
 group by reason
 order by reason;

\echo ''
\echo '== the invariant: a cancelled booking must hold no seats'
-- The whole point of archiving and deleting rather than only marking the status.
-- Any row here is a seat that reads available on the map and still raises 23505
-- on re-booking, which is the state Module 6.2 exists to prevent.
select b.id, b.booking_ref, count(bs.id) as still_claimed
  from bookings b
  join booking_seats bs on bs.booking_id = b.id
 where b.status = 'cancelled'
 group by b.id, b.booking_ref
 order by b.id;

\echo ''
\echo '== the Phase 2 guarantee, restated: no seat sold twice'
select bs.show_id, bs.seat_id, count(*) as times_sold
  from booking_seats bs
 group by bs.show_id, bs.seat_id
having count(*) > 1
 order by bs.show_id, bs.seat_id;

\echo ''
\echo '== late payments, and how they resolved'
-- refund_pending is a marker, not a refund: nothing in this build moves money
-- back. BACKLOG.md records that as a known limitation.
select b.status as booking_status,
       pe.status as event_status,
       count(*)  as events
  from payment_events pe
  join bookings b on b.id = pe.booking_id
 group by b.status, pe.status
 order by b.status, pe.status;

\echo ''
\echo '== bookings marked refund_pending, with the seats they lost'
select b.booking_ref,
       b.total_paise,
       count(r.id) as seats_released
  from bookings b
  left join released_booking_seats r on r.booking_id = b.id
 where b.status = 'refund_pending'
 group by b.booking_ref, b.total_paise
 order by b.booking_ref;
