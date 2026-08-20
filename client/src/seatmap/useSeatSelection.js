import { useCallback, useMemo, useState } from 'react';
import { isSelectable } from './seatIndex.js';

// Every piece of seat-selection state lives here, and nothing about how seats
// are drawn does. That split is the point: BACKLOG.md P1 replaces the DOM grid
// with a canvas renderer, and this hook should not notice.
//
// No JSX, no DOM, no window, no fetch — and no useEffect either. Selection is
// reconciled by derivation on each render rather than by an effect that fires
// afterwards, so a stale total never gets painted before being corrected.
export function useSeatSelection({ seats, maxSeats = 6 }) {
  // Ids only. Never an index, never row_label + seat_number: those describe
  // where a seat is drawn, and the API id is what the seat actually is.
  const [chosenIds, setChosenIds] = useState(() => new Set());

  const seatById = useMemo(() => {
    const byId = new Map();
    for (const seat of seats) byId.set(seat.id, seat);
    return byId;
  }, [seats]);

  // The live selection: chosen ids filtered against the seats as they are
  // right now. A seat that vanished from a refetched payload, or that someone
  // else has just booked, stops counting immediately — no effect, no flash.
  //
  // Iterating `seats` rather than the id set also fixes the order: the API
  // returns seats by row then number, so the selection reads in seating order.
  const selected = useMemo(
    () => seats.filter((seat) => chosenIds.has(seat.id) && isSelectable(seat.status)),
    [seats, chosenIds],
  );

  const selectedIds = useMemo(() => selected.map((seat) => seat.id), [selected]);
  const liveIds = useMemo(() => new Set(selectedIds), [selectedIds]);

  const count = selected.length;
  const limitReached = count >= maxSeats;

  // Integer arithmetic throughout. The only division in this codebase lives in
  // money.js, at the moment a string is rendered.
  const totalPaise = useMemo(
    () => selected.reduce((sum, seat) => sum + (seat.price_paise ?? 0), 0),
    [selected],
  );

  const breakdown = useMemo(() => {
    const byTier = new Map();

    for (const seat of selected) {
      const price = seat.price_paise ?? 0;
      const row = byTier.get(seat.tier);

      if (row) {
        row.count += 1;
        row.subtotalPaise += price;
      } else {
        byTier.set(seat.tier, {
          tier: seat.tier,
          count: 1,
          unitPaise: seat.price_paise,
          subtotalPaise: price,
        });
      }
    }

    return [...byTier.values()];
  }, [selected]);

  const isSelected = useCallback((id) => liveIds.has(id), [liveIds]);

  const toggle = useCallback(
    (id) => {
      setChosenIds((current) => {
        const seat = seatById.get(id);

        // An unknown seat, or one that is booked, held, or carrying a status
        // this build does not recognise, is not selectable. Refusing here as
        // well as in the UI keeps the rule in one place.
        if (!seat || !isSelectable(seat.status)) return current;

        const next = new Set(current);

        if (next.has(id)) {
          next.delete(id);
          return next;
        }

        // Count what is actually live, not what the set happens to remember,
        // so an id pruned by a refetch does not occupy one of the six slots.
        let live = 0;
        for (const chosen of next) {
          const other = seatById.get(chosen);
          if (other && isSelectable(other.status)) live += 1;
        }

        // The seventh seat is refused. Silently dropping the oldest would mean
        // a click that appears to work while removing a seat nobody asked to
        // give up. The server enforces the same ceiling; this is only UX.
        if (live >= maxSeats) return current;

        next.add(id);
        return next;
      });
    },
    [seatById, maxSeats],
  );

  const clear = useCallback(() => setChosenIds(new Set()), []);

  return { selectedIds, isSelected, toggle, clear, count, totalPaise, breakdown, limitReached };
}
