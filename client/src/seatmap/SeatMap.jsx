import { Fragment } from 'react';
import { SeatButton } from './SeatButton.jsx';
import { seatKey } from './seatIndex.js';
import './seatmap.css';

// Renders the grid and nothing else. No selection state lives here — that is
// Module 3.3 — which is also what keeps the canvas swap in BACKLOG.md P1 a
// change of render layer rather than a rewrite.
//
// The layout drives geometry: which rows exist, how many columns, where the
// aisles fall. The seats table decides which of those cells is a real seat. A
// cell with no seat is drawn as a gap, because seats is authoritative for seat
// identity and the layout is only a picture of it.
export function SeatMap({ layout, seatAt, isSelected, onToggle, limitReached = false }) {
  const aislesAfter = new Set(layout.aislesAfterColumn ?? []);

  return (
    <div className="seatmap">
      <p className="seatmap__screen">screen this way</p>

      <div className="seatmap__rows">
        {layout.rows.map((row) => (
          <div className="seatmap__row" key={row.label} data-row-label={row.label}>
            <span className="seatmap__row-label">{row.label}</span>

            {row.seatNumbers.map((seatNumber) => {
              const seat = seatAt.get(seatKey(row.label, seatNumber));

              return (
                // Keyed by the layout coordinate, which exists whether or not a
                // seat does. The seat's own id identifies the seat itself.
                <Fragment key={seatKey(row.label, seatNumber)}>
                  {seat ? (
                    <SeatButton
                      seat={seat}
                      selected={isSelected ? isSelected(seat.id) : false}
                      limitReached={limitReached}
                      onToggle={onToggle}
                    />
                  ) : (
                    <span className="seat seat--absent" aria-hidden="true" />
                  )}

                  {aislesAfter.has(seatNumber) ? (
                    <span className="seat-aisle" aria-hidden="true" />
                  ) : null}
                </Fragment>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
