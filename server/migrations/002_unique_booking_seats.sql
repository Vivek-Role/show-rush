-- Phase 2.4 — the fix.
--
-- Phase 1.2 created booking_seats deliberately without this constraint so the
-- naive path's double-booking race would be reproducible and measurable. That
-- measurement is recorded in loadtest/results/2.3-naive-2026-08-19.json:
-- 303, 150 and 303 seats sold twice out of 500 concurrent attempts.
--
-- This is the guarantee. Not the availability pre-check, not the transaction —
-- those make the common case pleasant. Under concurrency the database is the
-- only thing that can decide, because it is the only participant that sees
-- every transaction. A losing INSERT raises 23505 and the application turns it
-- into a clean 409.
--
-- The constraint is named explicitly rather than left to Postgres, because
-- bookingService classifies errors by constraint name: 23505 is also what a
-- booking_ref collision raises, and the two need different answers.
--
-- This will fail if duplicate (show_id, seat_id) rows are already present —
-- which is exactly the state a naive baseline run leaves behind. Re-seed
-- before applying. See docs/phases/phase-2-booking-core.md §14.

alter table booking_seats
  add constraint booking_seats_show_id_seat_id_key unique (show_id, seat_id);

-- booking_seats_show_id_seat_id_idx (Phase 1.2) is now redundant: the
-- constraint above creates its own unique index over the same columns.
-- Deliberately not dropped here — index changes belong to Phase 7.3b and are
-- approval-gated. Recorded as a deferred finding, not an oversight.
