// Where each seat is drawn. Pure — no React, no DOM, no canvas.
//
// This is the canvas renderer's answer to what CSS answers for the DOM grid,
// and it is deliberately the only place pixel positions are decided. The
// numbers below mirror seatmap.css so the two renderers lay seats out
// identically; a seat that moves when you switch VITE_SEAT_RENDERER would make
// the measurement comparison meaningless.
//
// Derived from the layout and nothing else. The layout is presentation
// (CLAUDE.md §10) and geometry is presentation about presentation, so this
// module never learns what a seat *is* — only where its cell sits. Whether a
// seat exists in a cell is answered by seatAt, which comes from the seats
// table, at draw time and at hit-test time.

import { seatKey } from './seatIndex.js';

// seatmap.css at a 16px root: --seat-size 1.75rem, --seat-gap 0.25rem,
// .seat-aisle 0.75 × seat size, .seatmap__row-label 2.5rem.
export const SEAT_SIZE = 28;
export const SEAT_GAP = 4;
export const AISLE_WIDTH = 21;
export const ROW_LABEL_WIDTH = 40;

// Room above the first row for the "screen this way" band, matching the DOM
// renderer's heading and its rule.
export const SCREEN_BAND = 48;

/**
 * Every layout cell, in world coordinates.
 *
 * Cells are emitted for coordinates that have no seat as well. The DOM grid
 * draws those as `.seat--absent` so the row stays aligned, and the same
 * reasoning applies here: skipping them would shift every seat to their right.
 * They carry no seat id, and hit-testing refuses them.
 *
 * Depends on the layout alone, never on seat status. That is what makes it
 * memoisable for the life of the show: a seat changing from available to booked
 * costs a repaint, not a rebuild of five thousand rectangles and a quadtree.
 */
export function buildGeometry(layout) {
  const cells = [];
  const rowLabels = [];
  const aislesAfter = new Set(layout?.aislesAfterColumn ?? []);
  const rows = layout?.rows ?? [];

  let widest = 0;

  rows.forEach((row, rowIndex) => {
    const y = SCREEN_BAND + rowIndex * (SEAT_SIZE + SEAT_GAP);

    rowLabels.push({ label: row.label, x: ROW_LABEL_WIDTH, y, height: SEAT_SIZE });

    // The label occupies its own column, then one gap, exactly as the flex row
    // does before its first seat.
    let x = ROW_LABEL_WIDTH + SEAT_GAP;

    for (const seatNumber of row.seatNumbers) {
      cells.push({
        key: seatKey(row.label, seatNumber),
        rowLabel: row.label,
        seatNumber,
        x,
        y,
        w: SEAT_SIZE,
        h: SEAT_SIZE,
      });

      x += SEAT_SIZE + SEAT_GAP;

      // An aisle is an extra flex item, so it costs its own width plus the gap
      // that follows it.
      if (aislesAfter.has(seatNumber)) x += AISLE_WIDTH + SEAT_GAP;
    }

    // Minus the trailing gap: it sits after the last seat and nothing follows.
    widest = Math.max(widest, x - SEAT_GAP);
  });

  const height =
    rows.length === 0 ? SCREEN_BAND : SCREEN_BAND + rows.length * (SEAT_SIZE + SEAT_GAP) - SEAT_GAP;

  return {
    cells,
    rowLabels,
    bounds: { x: 0, y: 0, w: Math.max(widest, ROW_LABEL_WIDTH), h: height },
  };
}
