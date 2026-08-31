-- Phase 6.0 — the archive that lets a seat be given back.
--
-- Phase 2.4's booking_seats_show_id_seat_id_key is UNIQUE (show_id, seat_id)
-- with no predicate, and availabilityService treats a cancelled booking's seats
-- as free (b.status <> 'cancelled'). Marking a booking cancelled and leaving its
-- booking_seats rows in place would therefore produce a seat that reads
-- 'available' on the map and still raises 23505 on re-booking — a worse state
-- than the one the reconciliation sweep exists to fix.
--
-- So the sweep deletes those rows, and this table is where they go first. That
-- keeps migration 002's constraint untouched — it is a protected Phase 2
-- artefact (CLAUDE.md §10) and making it partial, or denormalising
-- bookings.status onto booking_seats to allow one, was rejected.
--
-- It is an audit record, and the seat list Module 6.1 re-claims from when a
-- payment arrives after its booking expired. It is NEVER an availability
-- source: availabilityService does not read this table and must not learn to.
-- Seat-status truth stays on one query path (CLAUDE.md §10).

create table released_booking_seats (
  id          bigint generated always as identity primary key,
  booking_id  bigint      not null references bookings (id) on delete cascade,
  show_id     bigint      not null references shows (id),
  seat_id     bigint      not null references seats (id),
  released_at timestamptz not null default now(),
  -- One value today, so a second reason is a migration rather than free-text
  -- drift. 6.2 writes only 'expired'.
  reason      text        not null check (reason in ('expired'))
);

-- Deliberately NOT unique on (show_id, seat_id): the same seat can be released
-- many times over its life, by different bookings. Uniqueness here would be a
-- claim about seat identity, which belongs to the seats table alone.

-- Foreign-key hygiene only, matching Phase 1.2 and Phase 5.0. It supports the
-- one read 6.1 makes — the archived seats of a single booking. Index tuning is
-- Phase 7.3b and approval-gated.
create index released_booking_seats_booking_id_idx on released_booking_seats (booking_id);
