import { isSelectable } from './seatIndex.js';

// One seat. Still no state of its own — selection is owned by useSeatSelection
// and arrives as props, which is what lets the whole render layer be swapped
// for a canvas later without touching the selection rules.
export function SeatButton({ seat, selected = false, limitReached = false, onToggle }) {
  const selectable = isSelectable(seat.status);
  const label = `${seat.row_label}${seat.seat_number}`;

  // At the six-seat ceiling an unselected seat is refused, but it stays
  // focusable and keeps announcing itself: aria-disabled rather than disabled,
  // so it never silently drops out of the tab order.
  const blockedByLimit = selectable && limitReached && !selected;

  return (
    <button
      type="button"
      className="seat"
      // The id from the API is the seat's identity — never its position in the
      // layout, and never the row/number pair, which is presentation.
      data-seat-id={seat.id}
      data-seat-label={label}
      // Styling keys off the raw status string, so an unrecognised value falls
      // through to the neutral default rather than matching an "available" rule.
      data-status={seat.status}
      data-tier={seat.tier}
      data-selected={selected ? 'true' : undefined}
      disabled={!selectable}
      // The correct semantics for a toggle. A booked seat is not a toggle, so
      // it gets no pressed state at all.
      aria-pressed={selectable ? selected : undefined}
      aria-disabled={blockedByLimit ? 'true' : undefined}
      aria-label={`Seat ${label}, ${seat.tier}, ${selected ? 'selected' : seat.status}`}
      onClick={onToggle ? () => onToggle(seat.id) : undefined}
    >
      {seat.seat_number}
    </button>
  );
}
