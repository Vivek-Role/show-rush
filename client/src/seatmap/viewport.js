// The transform stack: zoom and pan, and the two conversions between screen
// pixels and world coordinates. Pure — no React, no DOM, no canvas.
//
// One transform, applied in one direction:
//
//   screen = world × scale + translate
//   world  = (screen − translate) ÷ scale
//
// The quadtree never learns about zoom. A click is converted to world
// coordinates once, then asked about; the visible region is converted to world
// coordinates once, then queried. Keeping the transform out of the tree is what
// lets the tree stay static.

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 4;

export function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function screenToWorld(view, screenX, screenY) {
  return { x: (screenX - view.tx) / view.scale, y: (screenY - view.ty) / view.scale };
}

export function worldToScreen(view, worldX, worldY) {
  return { x: worldX * view.scale + view.tx, y: worldY * view.scale + view.ty };
}

/**
 * Zoom about a screen point — the cursor, or the centre of the viewport. The
 * world point under that pixel must not move, which is the whole difference
 * between zoom that feels right and zoom that fights the user.
 */
export function zoomAt(view, screenX, screenY, factor) {
  const scale = clampScale(view.scale * factor);
  const anchor = screenToWorld(view, screenX, screenY);

  return {
    scale,
    tx: screenX - anchor.x * scale,
    ty: screenY - anchor.y * scale,
  };
}

export function pan(view, dx, dy) {
  return { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy };
}

/**
 * The world rectangle currently on screen. This is the culling query, and the
 * margin is deliberate: a seat half off the edge must still be drawn, or
 * panning would reveal a strip of blank canvas before the next frame catches
 * up.
 */
export function visibleWorldRect(view, viewWidth, viewHeight, margin = 0) {
  const topLeft = screenToWorld(view, -margin, -margin);
  const bottomRight = screenToWorld(view, viewWidth + margin, viewHeight + margin);

  return {
    x: topLeft.x,
    y: topLeft.y,
    w: bottomRight.x - topLeft.x,
    h: bottomRight.y - topLeft.y,
  };
}

/**
 * The opening view: the whole plan visible, never enlarged past 1:1.
 *
 * Scaling a 160-seat screen up to fill the viewport would draw seats the size
 * of playing cards; the DOM renderer does not do that, and the two must look
 * like the same seat map.
 */
export function fitToBounds(bounds, viewWidth, viewHeight) {
  if (bounds.w <= 0 || bounds.h <= 0) return { scale: 1, tx: 0, ty: 0 };

  const scale = clampScale(Math.min(1, Math.min(viewWidth / bounds.w, viewHeight / bounds.h)));

  return centreWithin({ scale, tx: 0, ty: 0 }, bounds, viewWidth, viewHeight);
}

/**
 * Keep the plan reachable. Smaller than the viewport on an axis, it is centred
 * on that axis; larger, it is clamped so the content edge cannot be dragged
 * into the middle of the screen and lost.
 */
export function centreWithin(view, bounds, viewWidth, viewHeight) {
  const contentW = bounds.w * view.scale;
  const contentH = bounds.h * view.scale;

  const tx =
    contentW <= viewWidth
      ? (viewWidth - contentW) / 2 - bounds.x * view.scale
      : Math.min(-bounds.x * view.scale, Math.max(viewWidth - contentW - bounds.x * view.scale, view.tx));

  const ty =
    contentH <= viewHeight
      ? (viewHeight - contentH) / 2 - bounds.y * view.scale
      : Math.min(-bounds.y * view.scale, Math.max(viewHeight - contentH - bounds.y * view.scale, view.ty));

  return { scale: view.scale, tx, ty };
}
