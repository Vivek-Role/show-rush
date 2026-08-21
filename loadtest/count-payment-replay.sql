-- Phase 5.4 — the counting method for the webhook replay run.
--
-- Run against the database the load test just hit, immediately after the run.
-- This is the measurement; webhook-replay.js only produces the requests.
--
--   docker exec -i showrush-postgres \
--     psql -U showrush -d showrush -f - < loadtest/count-payment-replay.sql
--
-- The done-when criterion, from PLAN.md 5.4: replaying one event 10,000 times
-- concurrently produces exactly one booking. Concretely — one payment_events
-- row, one paid booking, and not one extra booking_seats row.

\echo
\echo == the headline number: rows per payment event ==

select
  event_id,
  count(*)                     as rows_for_event,
  count(distinct booking_id)   as bookings_touched,
  min(status)                  as status,
  min(amount_paise)            as amount_paise
from payment_events
group by event_id
order by rows_for_event desc, event_id;

\echo
\echo == any event id written more than once? (must be empty) ==

select event_id, count(*) as rows_for_event
from payment_events
group by event_id
having count(*) > 1;

\echo
\echo == the bookings those events paid for ==

select
  b.booking_ref,
  b.status,
  b.total_paise,
  count(distinct pe.id) as payment_events,
  count(distinct bs.id) as seat_rows
from bookings b
left join payment_events pe on pe.booking_id = b.id
left join booking_seats   bs on bs.booking_id = b.id
group by b.id, b.booking_ref, b.status, b.total_paise
order by payment_events desc, b.id;

\echo
\echo == context: did the load actually reach the database? ==

select
  (select count(*) from bookings)                            as bookings,
  (select count(*) from bookings where status = 'paid')      as paid_bookings,
  (select count(*) from bookings where status = 'pending')   as pending_bookings,
  (select count(*) from booking_seats)                       as booking_seat_rows,
  (select count(*) from payment_events)                      as payment_event_rows;

\echo
\echo == the constraint that decides ==

select
  indexname,
  indexdef
from pg_indexes
where tablename = 'payment_events'
order by indexname;
