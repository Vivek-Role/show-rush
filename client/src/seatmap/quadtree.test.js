import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGeometry } from './geometry.js';
import { buildQuadtree, describeQuadtree, queryPoint, queryRect } from './quadtree.js';

const BOUNDS = { x: 0, y: 0, w: 100, h: 100 };

// A 4×4 grid of 10×10 rectangles on a 20px pitch, so there is a 10px gap
// between every pair — a click landing in a gap must find nothing.
function grid() {
  const rects = [];
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      rects.push({ key: `${row}:${col}`, x: col * 20, y: row * 20, w: 10, h: 10 });
    }
  }
  return rects;
}

test('finds the rectangle under a point', () => {
  const tree = buildQuadtree(grid(), BOUNDS);

  assert.equal(queryPoint(tree, 5, 5)?.key, '0:0');
  assert.equal(queryPoint(tree, 25, 45)?.key, '2:1');
  assert.equal(queryPoint(tree, 65, 65)?.key, '3:3');
});

test('a point in the gap between rectangles finds nothing', () => {
  const tree = buildQuadtree(grid(), BOUNDS);

  assert.equal(queryPoint(tree, 15, 15), null);
  assert.equal(queryPoint(tree, 5, 15), null);
});

test('a point outside the bounds finds nothing', () => {
  const tree = buildQuadtree(grid(), BOUNDS);

  assert.equal(queryPoint(tree, -1, -1), null);
  assert.equal(queryPoint(tree, 500, 500), null);
});

test('edges are half-open, so a shared boundary belongs to one rectangle only', () => {
  // Two rectangles touching exactly at x = 10.
  const touching = [
    { key: 'left', x: 0, y: 0, w: 10, h: 10 },
    { key: 'right', x: 10, y: 0, w: 10, h: 10 },
  ];
  const tree = buildQuadtree(touching, { x: 0, y: 0, w: 20, h: 20 });

  assert.equal(queryPoint(tree, 9.99, 5)?.key, 'left');
  assert.equal(queryPoint(tree, 10, 5)?.key, 'right');
  // The far edge belongs to nobody, so a click past the last seat is a miss.
  assert.equal(queryPoint(tree, 20, 5), null);
});

test('every rectangle is findable at its own top-left corner', () => {
  const rects = grid();
  const tree = buildQuadtree(rects, BOUNDS);

  for (const rect of rects) {
    assert.equal(queryPoint(tree, rect.x, rect.y)?.key, rect.key, `missed ${rect.key}`);
  }
});

test('a rectangle straddling a node boundary is still findable', () => {
  // Deliberately crosses the root's split at x = 50, y = 50, which is the case
  // that has to stay at a parent node rather than descend.
  const straddling = [...grid(), { key: 'straddler', x: 45, y: 45, w: 10, h: 10 }];
  const tree = buildQuadtree(straddling, BOUNDS, { maxPerNode: 2 });

  assert.equal(queryPoint(tree, 50, 50)?.key, 'straddler');
  assert.equal(queryPoint(tree, 46, 46)?.key, 'straddler');
});

test('queryRect returns everything intersecting and nothing else', () => {
  const tree = buildQuadtree(grid(), BOUNDS);

  const found = queryRect(tree, { x: 0, y: 0, w: 25, h: 25 });
  const keys = found.map((rect) => rect.key).sort();

  assert.deepEqual(keys, ['0:0', '0:1', '1:0', '1:1']);
});

test('queryRect over the whole bounds returns every rectangle exactly once', () => {
  const rects = grid();
  const tree = buildQuadtree(rects, BOUNDS);

  const found = queryRect(tree, BOUNDS);

  assert.equal(found.length, rects.length);
  assert.equal(new Set(found.map((rect) => rect.key)).size, rects.length);
});

test('queryRect appends into a caller-owned array, so the draw loop can reuse it', () => {
  const tree = buildQuadtree(grid(), BOUNDS);
  const out = [];

  const returned = queryRect(tree, { x: 0, y: 0, w: 5, h: 5 }, out);

  assert.equal(returned, out);
  assert.equal(out.length, 1);
});

test('an off-screen query returns nothing', () => {
  const tree = buildQuadtree(grid(), BOUNDS);

  assert.equal(queryRect(tree, { x: 200, y: 200, w: 50, h: 50 }).length, 0);
});

test('the tree actually subdivides rather than degenerating to one node', () => {
  const tree = buildQuadtree(grid(), BOUNDS, { maxPerNode: 2 });
  const shape = describeQuadtree(tree);

  assert.ok(shape.nodes > 1, 'expected the tree to split');
  assert.equal(shape.items, 16, 'every rectangle must be stored exactly once');
});

test('an empty tree answers both queries without throwing', () => {
  const tree = buildQuadtree([], BOUNDS);

  assert.equal(queryPoint(tree, 5, 5), null);
  assert.equal(queryRect(tree, BOUNDS).length, 0);
});

// The integration that matters: real seat geometry, hit-tested at the centre of
// every cell. This is the check that a click lands on the seat it looks like.
test('every seat cell of a real layout is hit at its centre, and only it', () => {
  const rows = [];
  for (let i = 0; i < 20; i += 1) {
    rows.push({
      label: String.fromCharCode(65 + i),
      tier: 'silver',
      seatNumbers: Array.from({ length: 20 }, (unused, n) => n + 1),
    });
  }

  const geometry = buildGeometry({ aislesAfterColumn: [5, 15], rows });
  const tree = buildQuadtree(geometry.cells, geometry.bounds);

  assert.equal(geometry.cells.length, 400);

  for (const cell of geometry.cells) {
    const hit = queryPoint(tree, cell.x + cell.w / 2, cell.y + cell.h / 2);
    assert.equal(hit?.key, cell.key, `centre of ${cell.key} did not hit itself`);
  }
});

test('the gap between two seats is not a hit', () => {
  const geometry = buildGeometry({
    aislesAfterColumn: [],
    rows: [{ label: 'A', tier: 'silver', seatNumbers: [1, 2] }],
  });
  const tree = buildQuadtree(geometry.cells, geometry.bounds);

  const first = geometry.cells[0];
  const gapX = first.x + first.w + 1;

  assert.equal(queryPoint(tree, gapX, first.y + first.h / 2), null);
});
