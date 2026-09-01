import { isSelectable } from './seatIndex.js';

// BACKLOG.md P3 — "best N together".
//
// Pure, and deliberately so: no React, no DOM, no fetch. It takes the seat list
// the server already sent and returns seat ids, which means it can be tested
// exhaustively without a browser and can never disagree with the server about
// which seats exist — it only ever chooses among seats it was handed.
//
// The rule a cinema actually uses: a group sits together, in one row, in
// consecutive seats. So this searches for contiguous runs and scores them,
// rather than picking the N "best" seats independently and hoping they touch.
//
// CONTIGUITY IS BY SEAT NUMBER, NOT BY ARRAY POSITION. Seats arrive ordered,
// but a row with a missing seat — the layout allows gaps — would otherwise
// yield a "run" that is split by a hole the visitor would have to climb over.
//
// An aisle is not modelled. Two seats either side of an aisle are consecutive
// by number and are treated as together, which is what a cinema does too: the
// aisle is where you walk in, not a wall.

// Where the best seat in the house is, as a fraction of the way back. Front row
// is 0, back row is 1. Cinemas put the reference seat around two thirds back,
// which is far enough that the screen fills the view without filling it too
// much.
const IDEAL_DEPTH = 0.65;

// How much row choice matters relative to being centred within the row. Both
// terms are distances in [0, 1] and the total is minimised, so this says "being
// in the right row is worth a little more than being dead centre in it".
const DEPTH_WEIGHT = 1.15;
const CENTRE_WEIGHT = 1;

/**
 * Group the selectable seats by row, in seat-number order.
 *
 * Sorting numerically rather than trusting arrival order: seat_number is a
 * number in the payload, and a lexicographic sort would put 10 before 2.
 */
function selectableRows(seats) {
  const rows = new Map();

  for (const seat of seats) {
    if (!isSelectable(seat.status)) continue;

    const row = rows.get(seat.row_label);
    if (row) row.push(seat);
    else rows.set(seat.row_label, [seat]);
  }

  for (const row of rows.values()) row.sort((a, b) => a.seat_number - b.seat_number);

  return rows;
}

/**
 * Every maximal run of consecutive seat numbers within one row.
 */
function runsIn(rowSeats) {
  const runs = [];
  let current = [];

  for (const seat of rowSeats) {
    const previous = current[current.length - 1];

    if (previous && seat.seat_number === previous.seat_number + 1) current.push(seat);
    else current = [seat];

    if (current.length === 1) runs.push(current);
  }

  return runs;
}

/**
 * Lower is better. Distance from the ideal depth plus distance from the centre
 * of the row the window sits in.
 *
 * The centre term is measured against the row's own extent rather than the
 * screen's, because a row that stops short of the full width is still centred
 * on its own middle — which is where the seats actually are.
 */
function scoreWindow({ window, rowIndex, rowCount, rowSeats }) {
  const depth = rowCount <= 1 ? IDEAL_DEPTH : rowIndex / (rowCount - 1);
  const depthCost = Math.abs(depth - IDEAL_DEPTH);

  const first = rowSeats[0].seat_number;
  const last = rowSeats[rowSeats.length - 1].seat_number;
  const span = last - first;

  const windowCentre =
    (window[0].seat_number + window[window.length - 1].seat_number) / 2;
  const rowCentre = (first + last) / 2;

  // Normalised so a wide row and a narrow one are compared fairly. A row with
  // one seat has no centre to be off, so it costs nothing.
  const centreCost = span === 0 ? 0 : Math.abs(windowCentre - rowCentre) / (span / 2);

  return DEPTH_WEIGHT * depthCost + CENTRE_WEIGHT * centreCost;
}

/**
 * Recommend `count` seats together.
 *
 * Returns an array of seat ids, in seating order, or an empty array when no row
 * has `count` consecutive selectable seats. Empty is a real answer — offering a
 * split group would be answering a different question than the one asked.
 *
 * `rowOrder` is the front-to-back order of row labels, which is the order the
 * layout lists them. Falling back to the order rows first appear in the seat
 * list keeps this usable with nothing but the seats array.
 */
export function recommendSeats(seats, { count = 2, rowOrder } = {}) {
  if (!Array.isArray(seats) || count <= 0) return [];

  const rows = selectableRows(seats);
  if (rows.size === 0) return [];

  const order = rowOrder?.length ? rowOrder : [...rows.keys()];
  const rowCount = order.length;

  let best = null;
  let bestScore = Infinity;

  order.forEach((label, rowIndex) => {
    const rowSeats = rows.get(label);
    if (!rowSeats || rowSeats.length < count) return;

    for (const run of runsIn(rowSeats)) {
      // Every window of the requested size inside this run.
      for (let start = 0; start + count <= run.length; start += 1) {
        const window = run.slice(start, start + count);
        const score = scoreWindow({ window, rowIndex, rowCount, rowSeats });

        // Strictly better only, so the first row reached — the one nearer the
        // front on a tie — wins, and the result is deterministic.
        if (score < bestScore) {
          bestScore = score;
          best = window;
        }
      }
    }
  });

  return best ? best.map((seat) => seat.id) : [];
}

/**
 * A human-readable label for a recommendation, e.g. "F7–F9" or "F7".
 *
 * Built from the seats rather than the ids, because an id says nothing a
 * visitor can find on the floor.
 */
export function describeSeats(seats) {
  if (!seats || seats.length === 0) return '';
  const first = seats[0];
  const last = seats[seats.length - 1];

  if (seats.length === 1) return `${first.row_label}${first.seat_number}`;
  return `${first.row_label}${first.seat_number}–${last.row_label}${last.seat_number}`;
}
