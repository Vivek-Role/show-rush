import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AISLE_WIDTH,
  ROW_LABEL_WIDTH,
  SCREEN_BAND,
  SEAT_GAP,
  SEAT_SIZE,
  buildGeometry,
} from './geometry.js';

// A two-row layout with an aisle after seat 2, mirroring the shape
// generateScreenLayout produces.
function layout() {
  return {
    seatsPerRow: 4,
    aislesAfterColumn: [2],
    tiers: ['silver'],
    rows: [
      { label: 'A', tier: 'silver', seatNumbers: [1, 2, 3, 4] },
      { label: 'B', tier: 'silver', seatNumbers: [1, 2, 3, 4] },
    ],
  };
}

const FIRST_X = ROW_LABEL_WIDTH + SEAT_GAP;

test('emits one cell per layout coordinate, seat or not', () => {
  const { cells } = buildGeometry(layout());
  assert.equal(cells.length, 8);
});

test('cell keys match seatIndex keys, so seatAt can be asked directly', () => {
  const { cells } = buildGeometry(layout());
  assert.equal(cells[0].key, 'A:1');
  assert.equal(cells[7].key, 'B:4');
});

test('seats advance by seat size plus gap', () => {
  const { cells } = buildGeometry(layout());

  assert.equal(cells[0].x, FIRST_X);
  assert.equal(cells[1].x, FIRST_X + SEAT_SIZE + SEAT_GAP);
});

test('an aisle costs its own width plus a gap, and only after its column', () => {
  const { cells } = buildGeometry(layout());

  const afterAisle = cells[2];
  const withoutAisle = FIRST_X + 2 * (SEAT_SIZE + SEAT_GAP);

  assert.equal(afterAisle.x, withoutAisle + AISLE_WIDTH + SEAT_GAP);

  // Seat 4 follows seat 3 normally: there is no aisle after column 3.
  assert.equal(cells[3].x, afterAisle.x + SEAT_SIZE + SEAT_GAP);
});

test('rows stack below the screen band', () => {
  const { cells } = buildGeometry(layout());

  assert.equal(cells[0].y, SCREEN_BAND);
  assert.equal(cells[4].y, SCREEN_BAND + SEAT_SIZE + SEAT_GAP);
});

test('every row starts at the same x, so columns line up', () => {
  const { cells } = buildGeometry(layout());

  for (let i = 0; i < 4; i += 1) {
    assert.equal(cells[i].x, cells[i + 4].x, `column ${i} misaligned between rows`);
  }
});

test('bounds cover the widest row and every row, with no trailing gap', () => {
  const { cells, bounds } = buildGeometry(layout());

  const rightmost = cells[3].x + SEAT_SIZE;
  assert.equal(bounds.w, rightmost);
  assert.equal(bounds.h, SCREEN_BAND + 2 * (SEAT_SIZE + SEAT_GAP) - SEAT_GAP);
});

test('a ragged layout is bounded by its widest row', () => {
  const ragged = layout();
  ragged.rows[1].seatNumbers = [1, 2];

  const { bounds, cells } = buildGeometry(ragged);
  const widestRowRight = cells[3].x + SEAT_SIZE;

  assert.equal(bounds.w, widestRowRight);
});

test('one row label per row, positioned at the label gutter', () => {
  const { rowLabels } = buildGeometry(layout());

  assert.equal(rowLabels.length, 2);
  assert.deepEqual(
    rowLabels.map((row) => row.label),
    ['A', 'B'],
  );
  assert.equal(rowLabels[0].x, ROW_LABEL_WIDTH);
});

test('multi-letter row labels are carried through untouched', () => {
  const wide = layout();
  wide.rows = [{ label: 'AA', tier: 'silver', seatNumbers: [1] }];

  const { cells, rowLabels } = buildGeometry(wide);

  assert.equal(cells[0].key, 'AA:1');
  assert.equal(rowLabels[0].label, 'AA');
});

test('an empty layout produces no cells and does not throw', () => {
  const { cells, bounds } = buildGeometry({ rows: [] });

  assert.equal(cells.length, 0);
  assert.equal(bounds.h, SCREEN_BAND);
});

test('a missing layout is survivable', () => {
  const { cells } = buildGeometry(undefined);
  assert.equal(cells.length, 0);
});
