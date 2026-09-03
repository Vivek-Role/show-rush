-- Cancellation + refund flow (BACKLOG.md P2) — the second release reason.
--
-- 004_released_booking_seats.sql wrote: "One value today, so a second reason is
-- a migration rather than free-text drift. 6.2 writes only 'expired'." This is
-- that migration, and nothing more than that migration.
--
-- WHY A CANCELLATION ARCHIVES AT ALL. The same structural reason the sweep
-- does: booking_seats_show_id_seat_id_key is an unconditional
-- UNIQUE (show_id, seat_id), while availabilityService treats a cancelled
-- booking's seats as free. A cancelled booking that kept its booking_seats rows
-- would leave a seat that reads 'available' on the map and still raises 23505
-- when somebody tries to take it. So the rows are archived here and deleted
-- there, exactly as Module 6.2 does it.
--
-- WHY A SECOND VALUE RATHER THAN REUSING 'expired'. The sweep gives seats back
-- because nobody finished paying. A cancellation gives them back because the
-- person who booked them asked. Both are releases; they are not the same event,
-- and an audit record that cannot tell them apart is a worse record.
--
-- Migration 002's unique constraint is untouched — it is a protected Phase 2
-- artefact (CLAUDE.md §10). No column, no index, no table is added here.

alter table released_booking_seats
  drop constraint released_booking_seats_reason_check;

alter table released_booking_seats
  add constraint released_booking_seats_reason_check
  check (reason in ('expired', 'cancelled'));

-- Still deliberately NOT unique on (show_id, seat_id), for the reason 004 gave:
-- the same seat can be released many times over its life, by different
-- bookings, and uniqueness here would be a claim about seat identity — which
-- belongs to the seats table alone.
--
-- This table remains an audit record and the list a late payment re-claims
-- from. It is NEVER an availability source: availabilityService does not read
-- it and must not learn to (CLAUDE.md §10).
