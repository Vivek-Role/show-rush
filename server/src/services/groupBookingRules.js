// BACKLOG.md P2 — group booking constraints: "no orphan single seat left
// between bookings. Constraint-satisfaction problem, real cinema rule."
//
// Pure. No React, no DOM, no Postgres, no Redis — it takes the seat list
// availabilityService already produced and answers one question, so it can be
// tested exhaustively and can never disagree with the server about which seats
// exist or what state they are in.
//
// THE RULE, STATED EXACTLY. An orphan is a single available seat with an
// unavailable seat immediately on both sides, in the same row, by seat number.
// One seat, both neighbours taken, nobody can use it.
//
// WHAT IS DELIBERATELY NOT AN ORPHAN, because the backlog says "between
// bookings" and nothing more:
//
//   - A lone seat at the end of a row. It has a wall on one side, not a
//     booking, and treating a wall as a boundary is a different and stricter
//     rule than the one written down.
//   - A lone seat beside an aisle. Same reason, and aisle seats are the easy
//     ones to sell.
//   - A gap of two or more. Two people can sit there.
//
// Those are judgement calls a real cinema might make differently. They are
// listed here rather than buried so that changing the rule later is a decision
// about seating policy, not an archaeology exercise.
//
// PRE-EXISTING ORPHANS ARE NOT THIS BOOKING'S FAULT. The check compares the
// orphans before against the orphans after, and only refuses when the booking
// would create new ones. Otherwise the first person to arrive after somebody
// else left a gap would be refused for it.

const AVAILABLE = 'available';

/**
 * Group seats into rows, each ordered by seat number.
 *
 * Numeric sort, never lexicographic: seat 10 must not sort before seat 2, or
 * adjacency is nonsense.
 */
function rowsOf(seats) {
  const rows = new Map();

  for (const seat of seats) {
    const row = rows.get(seat.row_label);
    if (row) row.push(seat);
    else rows.set(seat.row_label, [seat]);
  }

  for (const row of rows.values()) row.sort((a, b) => a.seat_number - b.seat_number);

  return rows;
}

/**
 * Seat ids that are lone available seats trapped between two taken ones.
 *
 * `takenIds` lets the caller ask "what would be orphaned if these were also
 * taken" without mutating anything.
 */
export function findOrphanSeats(seats, takenIds = []) {
  const alsoTaken = new Set(takenIds.map(String));
  const orphans = [];

  const isFree = (seat) => seat.status === AVAILABLE && !alsoTaken.has(String(seat.id));

  for (const row of rowsOf(seats).values()) {
    for (let i = 0; i < row.length; i += 1) {
      const seat = row[i];
      if (!isFree(seat)) continue;

      const left = row[i - 1];
      const right = row[i + 1];

      // A neighbour must exist and be adjacent by number. A missing seat in the
      // layout leaves a physical gap, not a neighbour, so a seat beside one is
      // not trapped between bookings.
      const trappedLeft = left && left.seat_number === seat.seat_number - 1 && !isFree(left);
      const trappedRight = right && right.seat_number === seat.seat_number + 1 && !isFree(right);

      if (trappedLeft && trappedRight) orphans.push(String(seat.id));
    }
  }

  return orphans;
}

/**
 * The orphans this booking would create that do not exist already.
 *
 * Returns seat ids, in row-then-number order, or an empty array when the
 * booking leaves the seating no worse than it found it.
 */
export function orphansCreatedBy(seats, bookingSeatIds) {
  const before = new Set(findOrphanSeats(seats));
  const after = findOrphanSeats(seats, bookingSeatIds);

  return after.filter((id) => !before.has(id));
}

/**
 * A human-readable list of the offending seats, e.g. "F7" or "F7 and F9".
 *
 * Built from the seats rather than the ids, because an id is not something a
 * visitor can find on the floor.
 */
export function describeOrphans(seats, orphanIds) {
  const wanted = new Set(orphanIds.map(String));
  const names = seats
    .filter((seat) => wanted.has(String(seat.id)))
    .map((seat) => `${seat.row_label}${seat.seat_number}`);

  if (names.length === 0) return '';
  if (names.length === 1) return names[0];

  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
