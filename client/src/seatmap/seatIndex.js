// Pure functions over a seat-map payload. No React, no DOM — this module is
// what Module 3.3's selection hook and, later, a canvas renderer both build on,
// so it must stay free of anything that assumes how seats are drawn.

// The layout says where a cell is; the seats table says whether a seat exists
// there. This key joins the two, and it is a string on purpose: row labels
// become multi-letter ("AA", "AB") once the stress layout lands in Module 3.5,
// so nothing here may do character arithmetic.
export function seatKey(rowLabel, seatNumber) {
  return `${rowLabel}:${seatNumber}`;
}

// status is an open set, not a boolean. Today the server sends 'available' and
// 'booked'; Phase 4.3 adds 'held' without changing the response shape. Anything
// this build does not recognise must be treated as not selectable, never as
// available — guessing in the permissive direction sells a seat twice.
export function isSelectable(status) {
  return status === 'available';
}

// One pass over the flat seat list.
//
// seatAt is keyed by layout coordinates so rendering can ask "is there a seat
// here?" without scanning. tierPrices is collected from the seats themselves
// rather than from a constant: the price arrives per show, and the legend must
// show what the server actually charged, not what the client assumes.
export function buildSeatIndex(seats) {
  const seatAt = new Map();
  const tierPrices = new Map();

  for (const seat of seats) {
    seatAt.set(seatKey(seat.row_label, seat.seat_number), seat);

    if (!tierPrices.has(seat.tier)) {
      // May legitimately be null: show_prices is a LEFT JOIN, so a tier with no
      // configured price yields null rather than a row. The legend renders that
      // as an em dash instead of inventing a number.
      tierPrices.set(seat.tier, seat.price_paise);
    }
  }

  return { seatAt, tierPrices };
}
