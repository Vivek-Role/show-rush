import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeSeats, recommendSeats } from './recommend.js';

// Rows front to back: A, B, C. Seat numbers 1..n.
function row(label, numbers, status = 'available') {
  return numbers.map((n) => ({
    id: `${label}${n}`,
    row_label: label,
    seat_number: n,
    status,
    tier: 'silver',
    price_paise: 20000,
  }));
}

test('picks a contiguous run of the requested size', () => {
  const seats = row('A', [1, 2, 3, 4, 5]);
  const picked = recommendSeats(seats, { count: 3, rowOrder: ['A'] });

  assert.equal(picked.length, 3);
  const numbers = picked.map((id) => Number(id.slice(1)));
  assert.deepEqual(numbers, [numbers[0], numbers[0] + 1, numbers[0] + 2]);
});

test('prefers the centre of the row', () => {
  // 9 seats, want 3: the centred window is 4,5,6.
  const seats = row('A', [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(recommendSeats(seats, { count: 3, rowOrder: ['A'] }), ['A4', 'A5', 'A6']);
});

test('will not split a group across a gap in seat numbers', () => {
  // 1,2 then a hole at 3, then 4,5. No run of three exists.
  const seats = [...row('A', [1, 2]), ...row('A', [4, 5])];
  assert.deepEqual(recommendSeats(seats, { count: 3, rowOrder: ['A'] }), []);

  // Two together is still possible, and must come from one side of the hole.
  const pair = recommendSeats(seats, { count: 2, rowOrder: ['A'] });
  assert.equal(pair.length, 2);
  const numbers = pair.map((id) => Number(id.slice(1)));
  assert.equal(numbers[1] - numbers[0], 1);
});

test('booked and held seats are never recommended', () => {
  const seats = [
    ...row('A', [1, 2], 'booked'),
    ...row('A', [3, 4], 'held'),
    ...row('A', [5, 6]),
  ];

  assert.deepEqual(recommendSeats(seats, { count: 2, rowOrder: ['A'] }), ['A5', 'A6']);
});

test('an unrecognised status is treated as unavailable', () => {
  const seats = [...row('A', [1, 2], 'reserved-somehow'), ...row('A', [3, 4])];
  assert.deepEqual(recommendSeats(seats, { count: 2, rowOrder: ['A'] }), ['A3', 'A4']);
});

test('prefers a row about two thirds back over the front row', () => {
  // Five rows, all identical and fully centred. The ideal depth is 0.65, which
  // with rows at 0, 0.25, 0.5, 0.75, 1 lands nearest to D.
  const labels = ['A', 'B', 'C', 'D', 'E'];
  const seats = labels.flatMap((label) => row(label, [1, 2, 3, 4]));

  const picked = recommendSeats(seats, { count: 2, rowOrder: labels });
  assert.equal(picked[0][0], 'D');
});

test('returns empty when no row can seat the group', () => {
  const seats = [...row('A', [1, 2]), ...row('B', [1])];
  assert.deepEqual(recommendSeats(seats, { count: 4, rowOrder: ['A', 'B'] }), []);
});

test('handles an empty map and a zero count without throwing', () => {
  assert.deepEqual(recommendSeats([], { count: 2 }), []);
  assert.deepEqual(recommendSeats(row('A', [1, 2]), { count: 0, rowOrder: ['A'] }), []);
  assert.deepEqual(recommendSeats(null, { count: 2 }), []);
});

test('falls back to the order rows appear when no rowOrder is given', () => {
  const seats = [...row('A', [1, 2]), ...row('B', [1, 2])];
  const picked = recommendSeats(seats, { count: 2 });

  assert.equal(picked.length, 2);
});

test('seat numbers sort numerically, not lexicographically', () => {
  // 2 and 10 must not be adjacent. With a string sort, 1,10,2 would look
  // contiguous and produce a nonsense pair.
  const seats = row('A', [1, 2, 10]);
  const picked = recommendSeats(seats, { count: 2, rowOrder: ['A'] });

  assert.deepEqual(picked, ['A1', 'A2']);
});

test('describeSeats reads like a ticket', () => {
  const seats = row('F', [7, 8, 9]);
  assert.equal(describeSeats(seats), 'F7–F9');
  assert.equal(describeSeats(row('F', [7])), 'F7');
  assert.equal(describeSeats([]), '');
});
