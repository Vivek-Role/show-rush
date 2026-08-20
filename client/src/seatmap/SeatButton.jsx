import { isSelectable } from './seatIndex.js';

// One seat. Rendering only — Module 3.3 supplies isSelected and onToggle as
// props, and there is deliberately no click handler and no state here.
export function SeatButton({ seat }) {
  const selectable = isSelectable(seat.status);
  const label = `${seat.row_label}${seat.seat_number}`;

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
      disabled={!selectable}
      aria-label={`Seat ${label}, ${seat.tier}, ${seat.status}`}
    >
      {seat.seat_number}
    </button>
  );
}
