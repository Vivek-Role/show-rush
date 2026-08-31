import { Fragment } from 'react';
import { SeatCanvas } from './SeatCanvas.jsx';
import { SeatButton } from './SeatButton.jsx';
import { seatKey } from './seatIndex.js';
import './seatmap.css';

// BACKLOG.md P1 — which renderer draws the seats.
//
// Both ship permanently, the same way BOOKING_MODE and VITE_SEAT_UPDATE_MODE
// both keep their two paths: the DOM grid is the baseline the canvas is
// measured against, and a before-number that cannot be re-run is a claim
// rather than a measurement. It is also the only accessible path — a canvas
// has no seat elements, no focus order and no aria-pressed, and BACKLOG.md P3
// keeps canvas accessibility as its own deferred item.
//
// Anything other than 'dom' is canvas, so a typo cannot silently select a
// renderer nobody asked for; the default is canvas.
const RENDERER = import.meta.env.VITE_SEAT_RENDERER === 'dom' ? 'dom' : 'canvas';

// Renders the grid and nothing else. No selection state lives here — that is
// Module 3.3 — which is also what kept the canvas swap in BACKLOG.md P1 a
// change of render layer rather than a rewrite.
//
// The layout drives geometry: which rows exist, how many columns, where the
// aisles fall. The seats table decides which of those cells is a real seat. A
// cell with no seat is drawn as a gap, because seats is authoritative for seat
// identity and the layout is only a picture of it.
export function SeatMap({
  layout,
  seatAt,
  isSelected,
  isPending,
  onToggle,
  limitReached = false,
}) {
  if (RENDERER === 'canvas') {
    return (
      <SeatCanvas
        layout={layout}
        seatAt={seatAt}
        isSelected={isSelected}
        isPending={isPending}
        onToggle={onToggle}
        limitReached={limitReached}
      />
    );
  }

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
                      pending={isPending ? isPending(seat.id) : false}
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
