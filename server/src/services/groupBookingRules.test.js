import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeOrphans, findOrphanSeats, orphansCreatedBy } from './groupBookingRules.js';

// One row, seats numbered from 1. `pattern` is one character per seat:
//   '.' available   'X' taken (booked or held)
function row(label, pattern, startAt = 1) {
  return [...pattern].map((mark, i) => ({
    id: `${label}${startAt + i}`,
    row_label: label,
    seat_number: startAt + i,
    status: mark === 'X' ? 'booked' : 'available',
  }));
}

test('a seat with taken neighbours on both sides is an orphan', () => {
  assert.deepEqual(findOrphanSeats(row('A', 'X.X')), ['A2']);
});

test('a lone seat at the end of a row is not an orphan', () => {
  // A wall is not a booking. The backlog's rule is "between bookings".
  assert.deepEqual(findOrphanSeats(row('A', '.XX')), []);
  assert.deepEqual(findOrphanSeats(row('A', 'XX.')), []);
});

test('a gap of two or more is not an orphan', () => {
  assert.deepEqual(findOrphanSeats(row('A', 'X..X')), []);
  assert.deepEqual(findOrphanSeats(row('A', 'X...X')), []);
});

test('several orphans in one row are all reported', () => {
  assert.deepEqual(findOrphanSeats(row('A', 'X.X.X')), ['A2', 'A4']);
});

test('rows are independent', () => {
  const seats = [...row('A', 'X.X'), ...row('B', '...')];
  assert.deepEqual(findOrphanSeats(seats), ['A2']);
});

test('a held seat counts as taken', () => {
  const seats = row('A', '...');
  seats[0].status = 'held';
  seats[2].status = 'held';

  assert.deepEqual(findOrphanSeats(seats), ['A2']);
});

test('a missing seat in the layout is a gap, not a neighbour', () => {
  // Seats 1 and 3 exist, 2 does not. Seat 3 is beside a hole, not beside a
  // booking, so it is not trapped between bookings.
  const seats = [
    { id: 'A1', row_label: 'A', seat_number: 1, status: 'booked' },
    { id: 'A3', row_label: 'A', seat_number: 3, status: 'available' },
    { id: 'A4', row_label: 'A', seat_number: 4, status: 'booked' },
  ];

  assert.deepEqual(findOrphanSeats(seats), []);
});

test('seat numbers are compared numerically, not as strings', () => {
  // 9, 10, 11: a string sort would order these 10, 11, 9 and lose adjacency.
  const seats = row('A', 'X.X', 9);
  assert.deepEqual(findOrphanSeats(seats), ['A10']);
});

test('a booking that strands a seat is reported', () => {
  // A2 free, A1 booked; booking A3 traps A2.
  const seats = row('A', 'X..');
  assert.deepEqual(orphansCreatedBy(seats, ['A3']), ['A2']);
});

test('a booking that leaves no gap is allowed', () => {
  const seats = row('A', '.....');
  assert.deepEqual(orphansCreatedBy(seats, ['A1', 'A2']), []);
  assert.deepEqual(orphansCreatedBy(seats, ['A2', 'A3', 'A4']), []);
});

test('a booking leaving a gap of two is allowed', () => {
  const seats = row('A', '.....');
  assert.deepEqual(orphansCreatedBy(seats, ['A1', 'A4', 'A5']), []);
});

test('an orphan that already exists is not blamed on this booking', () => {
  // A2 is already stranded between A1 and A3. Booking A6 leaves A4 and A5 free
  // side by side, so it creates nothing — and must not be refused for somebody
  // else's gap.
  const seats = row('A', 'X.X...');
  assert.deepEqual(findOrphanSeats(seats), ['A2']);
  assert.deepEqual(orphansCreatedBy(seats, ['A6']), []);
});

test('a booking next to an existing gap can still strand a seat', () => {
  // A1 booked, A3 booked. Booking A5 puts A4 between A3 and A5 — a new orphan,
  // reported even though A2 was already stranded before this booking.
  const seats = row('A', 'X.X..');
  assert.deepEqual(orphansCreatedBy(seats, ['A5']), ['A4']);
});

test('booking the orphan itself is allowed', () => {
  // Taking the stranded seat removes the problem rather than creating one.
  const seats = row('A', 'X.X');
  assert.deepEqual(orphansCreatedBy(seats, ['A2']), []);
});

test('a booking can strand seats in more than one row at once', () => {
  const seats = [...row('A', 'X..'), ...row('B', 'X..')];
  assert.deepEqual(orphansCreatedBy(seats, ['A3', 'B3']), ['A2', 'B2']);
});

test('describeOrphans names seats the way a visitor reads them', () => {
  const seats = [...row('A', 'X.X'), ...row('B', 'X.X')];

  assert.equal(describeOrphans(seats, ['A2']), 'A2');
  assert.equal(describeOrphans(seats, ['A2', 'B2']), 'A2 and B2');
  assert.equal(describeOrphans(seats, []), '');
});

test('an empty seat map is not an error', () => {
  assert.deepEqual(findOrphanSeats([]), []);
  assert.deepEqual(orphansCreatedBy([], ['A1']), []);
});
