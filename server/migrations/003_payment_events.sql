-- Phase 5.0 — the idempotency guarantee.
--
-- One row per provider payment event. The unique constraint on event_id is the
-- whole mechanism: a replayed webhook loses the INSERT and is answered from the
-- row the winner wrote, rather than doing the work a second time.
--
-- The same argument 002_unique_booking_seats.sql makes for seats applies here.
-- Application code makes the common case pleasant; under concurrency the
-- database is the only participant that sees every transaction, so it is the
-- only one that can decide. There is deliberately no SELECT-then-INSERT in
-- paymentService — that is the Phase 2.1 race with a different table name.
--
-- The constraint is named explicitly rather than left to Postgres, because
-- paymentService classifies errors by constraint name: 23505 is also what a
-- bookings.booking_ref collision raises, and the two need different answers.

create table payment_events (
  id           bigint generated always as identity primary key,
  -- The provider's own event id. Unique globally, not per booking: the id
  -- identifies the event, and scoping it to a booking would let one id do its
  -- work twice against two different bookings.
  event_id     text        not null,
  booking_id   bigint      not null references bookings (id),
  -- Failures are events too, and are recorded. A replayed failure is answered
  -- from this row without re-running the provider.
  status       text        not null check (status in ('succeeded', 'failed')),
  -- A snapshot of bookings.total_paise at confirmation time. A payment record
  -- that silently follows a later price change is not a record.
  amount_paise integer     not null check (amount_paise >= 0),
  created_at   timestamptz not null default now(),
  constraint payment_events_event_id_key unique (event_id)
);

-- No updated_at: an event is immutable once written.

-- Foreign-key hygiene only, matching Phase 1.2. Index tuning is Phase 7.3b.
create index payment_events_booking_id_idx on payment_events (booking_id);
