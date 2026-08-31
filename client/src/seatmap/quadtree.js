// A static region quadtree over axis-aligned rectangles. Pure — no React, no
// DOM, no canvas, no dependency.
//
// Two jobs, and they are the two the canvas renderer cannot do without:
//
//   queryPoint  hit-testing. A click is a coordinate; this turns it into a
//               seat without scanning five thousand rectangles.
//   queryRect   viewport culling. Draw what is on screen, not what exists.
//
// Static on purpose. Seat geometry is fixed for the life of a show — only seat
// *status* changes — so there is no insert-after-build or remove path here to
// get wrong. Rebuilding is what happens if the layout changes, and the layout
// does not change.
//
// The items are non-overlapping cells, so queryPoint returning the first
// containing rectangle is exact rather than a nearest-match approximation.

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_PER_NODE = 8;

function makeNode(x, y, w, h, depth) {
  return { x, y, w, h, depth, items: [], children: null };
}

function containsRect(node, rect) {
  return (
    rect.x >= node.x &&
    rect.y >= node.y &&
    rect.x + rect.w <= node.x + node.w &&
    rect.y + rect.h <= node.y + node.h
  );
}

function intersects(node, rect) {
  return !(
    rect.x > node.x + node.w ||
    rect.x + rect.w < node.x ||
    rect.y > node.y + node.h ||
    rect.y + rect.h < node.y
  );
}

// Half-open on the right and bottom edges, so a point on the shared boundary of
// two cells belongs to exactly one of them. Without this a click on a seat's
// right edge could resolve to its neighbour.
function containsPoint(rect, x, y) {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

function split(node) {
  const hw = node.w / 2;
  const hh = node.h / 2;
  const d = node.depth + 1;

  node.children = [
    makeNode(node.x, node.y, hw, hh, d),
    makeNode(node.x + hw, node.y, hw, hh, d),
    makeNode(node.x, node.y + hh, hw, hh, d),
    makeNode(node.x + hw, node.y + hh, hw, hh, d),
  ];
}

function insert(node, rect, maxDepth, maxPerNode) {
  // A rectangle straddling a child boundary stays at this level. That is what
  // keeps the tree exact without duplicating an item into several children and
  // then having to de-duplicate every query result.
  if (node.children) {
    for (const child of node.children) {
      if (containsRect(child, rect)) {
        insert(child, rect, maxDepth, maxPerNode);
        return;
      }
    }

    node.items.push(rect);
    return;
  }

  node.items.push(rect);

  if (node.items.length <= maxPerNode || node.depth >= maxDepth) return;

  split(node);

  // Redistribute what can move down; what straddles a boundary stays put.
  const staying = [];
  for (const item of node.items) {
    const child = node.children.find((candidate) => containsRect(candidate, item));
    if (child) insert(child, item, maxDepth, maxPerNode);
    else staying.push(item);
  }
  node.items = staying;
}

/**
 * Build the tree. `bounds` is the world rectangle every item lives inside —
 * geometry.js produces it alongside the cells.
 */
export function buildQuadtree(rects, bounds, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxPerNode = options.maxPerNode ?? DEFAULT_MAX_PER_NODE;

  const root = makeNode(bounds.x, bounds.y, bounds.w, bounds.h, 0);
  for (const rect of rects) insert(root, rect, maxDepth, maxPerNode);

  return root;
}

/**
 * The rectangle at this point, or null. Hit-testing.
 *
 * Descends one child per level rather than searching siblings: a point is
 * inside at most one quadrant, so this is O(depth + items examined) and not a
 * scan. Items held at each level on the way down are checked, because a
 * boundary-straddling rectangle lives above the quadrant the point falls in.
 */
export function queryPoint(node, x, y) {
  if (!node) return null;
  if (x < node.x || x > node.x + node.w || y < node.y || y > node.y + node.h) return null;

  for (const item of node.items) {
    if (containsPoint(item, x, y)) return item;
  }

  if (!node.children) return null;

  for (const child of node.children) {
    if (x < child.x || x > child.x + child.w || y < child.y || y > child.y + child.h) continue;
    const found = queryPoint(child, x, y);
    if (found) return found;
  }

  return null;
}

/**
 * Every rectangle intersecting this one. Viewport culling.
 *
 * `out` is passed in and reused by the draw loop: allocating a fresh array
 * every frame is exactly the per-frame garbage that shows up as stutter.
 */
export function queryRect(node, rect, out = []) {
  if (!node || !intersects(node, rect)) return out;

  for (const item of node.items) {
    if (intersects(item, rect)) out.push(item);
  }

  if (node.children) {
    for (const child of node.children) queryRect(child, rect, out);
  }

  return out;
}

/**
 * Node and item counts. Used by the tests, and reported once alongside the M1
 * measurement so the tree's shape is part of the recorded evidence rather than
 * an assumption about it.
 */
export function describeQuadtree(node) {
  let nodes = 0;
  let items = 0;
  let maxDepth = 0;

  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    nodes += 1;
    items += current.items.length;
    maxDepth = Math.max(maxDepth, current.depth);

    if (current.children) stack.push(...current.children);
  }

  return { nodes, items, maxDepth };
}
