import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ROW_LABEL_WIDTH, SCREEN_BAND, buildGeometry } from './geometry.js';
import { buildQuadtree, describeQuadtree, queryPoint, queryRect } from './quadtree.js';
import { isSelectable } from './seatIndex.js';
import {
  centreWithin,
  fitToBounds,
  screenToWorld,
  visibleWorldRect,
  zoomAt,
} from './viewport.js';

// BACKLOG.md P1 — the canvas renderer.
//
// It is a render layer and nothing else. Every selection rule still lives in
// useSeatSelection, every hold rule in useSeatHolds, every seat status in the
// payload; this file reads them and calls onToggle. It owns no seat state, and
// its props are identical in meaning to SeatMap's, which is what makes the two
// renderers interchangeable rather than two implementations of the same idea.
//
// The DOM renderer is not replaced. Both ship permanently behind
// VITE_SEAT_RENDERER, for the reason BOOKING_MODE=naive and
// VITE_SEAT_UPDATE_MODE=immediate both still exist: a before-number that cannot
// be re-run is a claim rather than a measurement. It also keeps SeatButton's
// accessibility available, which canvas has none of — see the note at the end.

// Mirrors seatmap.css. An unrecognised tier falls through to neutral rather
// than to something that looks available, exactly as the stylesheet does.
const TIER_FILL = {
  silver: '#e4e4e7',
  gold: '#fde68a',
  platinum: '#c7d2fe',
};

const NEUTRAL_FILL = '#d4d4d8';
const SEAT_BORDER = '#a1a1aa';
const SEAT_TEXT = '#27272a';

const TAKEN_FILL = '#52525b';
const TAKEN_BORDER = '#3f3f46';
const TAKEN_TEXT = '#a1a1aa';

const SELECTED_FILL = '#16a34a';
const SELECTED_BORDER = '#14532d';
const SELECTED_TEXT = '#f0fdf4';
const SELECTED_RING = '#f0fdf4';
const PENDING_RING = '#bbf7d0';

const HOVER_OUTLINE = '#2563eb';
const LABEL_TEXT = '#71717a';
const SCREEN_LINE = '#a1a1aa';

// Below these zoom levels the glyphs are smaller than the ink used to draw
// them. Recorded in the M1 notes as a documented behaviour rather than left as
// a surprise: at stadium scale the numbers genuinely are not legible, and
// drawing them anyway would cost thousands of fillText calls a frame to
// produce mud.
const SEAT_NUMBER_MIN_SCALE = 0.75;
const ROW_LABEL_MIN_SCALE = 0.45;

// A press that travels further than this was a drag. Without it, panning
// selects whatever seat the gesture started on.
const DRAG_THRESHOLD_PX = 4;

const WHEEL_ZOOM_STEP = 1.0015;

// One frame of culling margin, so a seat entering from the edge is already
// drawn when it arrives.
const CULL_MARGIN_PX = 64;

// The measurement surface, in the shape useSeatEvents.js established for
// Module 6.4: counters on window, read from the console during a recorded run.
// Nothing renders them and nothing branches on them.
function counters() {
  if (typeof window === 'undefined') return null;

  window.__srSeatRender ??= {
    renderer: 'canvas',
    frames: 0,
    shapesDrawn: 0,
    shapesTotal: 0,
    lastDrawMs: 0,
    clickToDrawMs: [],
    quadtree: null,
    // The display-rate gate. M1 publishes no FPS number unless the tab is
    // demonstrably running at the panel's rate, so the probe that decides that
    // ships with the thing it gates rather than living in a document as a
    // snippet somebody has to retype correctly.
    fpsProbe(ms = 2000) {
      return new Promise((resolve) => {
        const start = performance.now();
        let frames = 0;

        const tick = () => {
          frames += 1;
          const elapsed = performance.now() - start;
          if (elapsed >= ms) resolve({ frames, ms: elapsed, hz: (frames * 1000) / elapsed });
          else requestAnimationFrame(tick);
        };

        requestAnimationFrame(tick);
      });
    },
  };

  return window.__srSeatRender;
}

// Adds one seat to the current path. `fresh` starts a new path; without it the
// seat joins whatever path is open, which is what lets a whole bucket of seats
// be filled and stroked in one pair of calls.
function addSeatPath(ctx, cell, fresh = false) {
  if (fresh) ctx.beginPath();

  if (typeof ctx.roundRect === 'function') ctx.roundRect(cell.x, cell.y, cell.w, cell.h, 4);
  else ctx.rect(cell.x, cell.y, cell.w, cell.h);
}

export function SeatCanvas({
  layout,
  seatAt,
  isSelected,
  isPending,
  onToggle,
  limitReached = false,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);

  // Geometry and the tree depend on the layout alone — never on seat status.
  // That is what makes a seat going from available to booked cost one repaint
  // instead of rebuilding thousands of rectangles and the tree over them.
  const geometry = useMemo(() => buildGeometry(layout), [layout]);
  const tree = useMemo(() => buildQuadtree(geometry.cells, geometry.bounds), [geometry]);

  // The view is a ref, not state. Panning at 60 Hz through React would be a
  // render per frame to move a number the renderer reads directly.
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const sizeRef = useRef({ width: 0, height: 0 });
  const frameRef = useRef(null);
  const hoverRef = useRef(null);
  const pressRef = useRef(null);
  const clickMarkRef = useRef(null);
  const fittedRef = useRef(false);

  // Everything the draw reads from props, kept in one ref so the draw callback
  // has a stable identity and the effects below never tear anything down when
  // a parent hands down a new closure.
  const propsRef = useRef(null);
  propsRef.current = { seatAt, isSelected, isPending, onToggle, limitReached };

  // Reused across frames. A fresh array of visible cells every frame is exactly
  // the per-frame garbage that shows up as stutter while panning.
  const visibleRef = useRef([]);

  const draw = useCallback(() => {
    frameRef.current = null;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const started = performance.now();
    const { width, height } = sizeRef.current;
    if (width === 0 || height === 0) return;

    const view = viewRef.current;
    const seats = propsRef.current.seatAt;
    const selectedOf = propsRef.current.isSelected;
    const pendingOf = propsRef.current.isPending;
    const atLimit = propsRef.current.limitReached;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // World space from here down. One transform, applied once — the quadtree
    // below is queried in world coordinates and never learns about zoom.
    ctx.save();
    ctx.translate(view.tx, view.ty);
    ctx.scale(view.scale, view.scale);

    const visible = visibleRef.current;
    visible.length = 0;
    queryRect(tree, visibleWorldRect(view, width, height, CULL_MARGIN_PX), visible);

    // The screen band, drawn in world space so it pans and zooms with the plan
    // it belongs to.
    const bounds = geometry.bounds;
    ctx.strokeStyle = SCREEN_LINE;
    ctx.lineWidth = 2 / view.scale;
    ctx.beginPath();
    ctx.moveTo(ROW_LABEL_WIDTH, SCREEN_BAND - 16);
    ctx.lineTo(bounds.w, SCREEN_BAND - 16);
    ctx.stroke();

    if (view.scale >= ROW_LABEL_MIN_SCALE) {
      ctx.fillStyle = LABEL_TEXT;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('SCREEN THIS WAY', (ROW_LABEL_WIDTH + bounds.w) / 2, SCREEN_BAND - 24);

      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const row of geometry.rowLabels) {
        ctx.fillText(row.label, row.x - 8, row.y + row.height / 2);
      }
    }

    const hover = hoverRef.current;
    let drawn = 0;

    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '10px system-ui, sans-serif';

    // Seats are bucketed by appearance and drawn one bucket at a time, rather
    // than one seat at a time.
    //
    // This is the single thing that decides whether a stadium is usable. Filling
    // and stroking each seat separately means 5,000 paths per frame at full
    // zoom-out, and rasterising those costs far more than the JavaScript that
    // issues them: measured at 8.1 Hz while panning, against a 59 Hz display.
    // There are only a handful of distinct appearances — three tiers, taken,
    // and dimmed variants — so the same 5,000 rectangles collapse into about
    // five paths.
    //
    // Seats that are selected, pending or hovered are drawn individually
    // afterwards. There are at most seven of them (the six-seat ceiling plus
    // the seat under the cursor), so they cost nothing and keeping them out of
    // the buckets is what keeps the dashes and rings simple.
    const buckets = new Map();
    const special = [];
    const labels = view.scale >= SEAT_NUMBER_MIN_SCALE ? [] : null;

    for (const cell of visible) {
      // A layout coordinate with no seat behind it. The DOM renderer draws
      // `.seat--absent` here for alignment; the canvas simply leaves the space,
      // because the geometry has already reserved it.
      const seat = seats.get(cell.key);
      if (!seat) continue;

      drawn += 1;

      const selectable = isSelectable(seat.status);
      const selected = selectedOf ? selectedOf(seat.id) : false;
      const pending = pendingOf ? pendingOf(seat.id) : false;
      const hovered = Boolean(hover) && hover.key === cell.key && selectable;

      let fill = TIER_FILL[seat.tier] ?? NEUTRAL_FILL;
      let border = SEAT_BORDER;
      let text = SEAT_TEXT;

      if (!selectable) {
        fill = TAKEN_FILL;
        border = TAKEN_BORDER;
        text = TAKEN_TEXT;
      }

      if (selected) {
        fill = SELECTED_FILL;
        border = SELECTED_BORDER;
        text = SELECTED_TEXT;
      }

      if (labels) labels.push({ cell, text, value: String(seat.seat_number) });

      if (selected || pending || hovered) {
        special.push({ cell, fill, border, selected, pending, hovered });
        continue;
      }

      // At the six-seat ceiling an unselected seat is refused. Dimmed, not
      // removed — the same thing seatmap.css does with aria-disabled.
      const blocked = selectable && atLimit;
      const key = `${fill}|${border}|${blocked ? 1 : 0}`;

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { fill, border, blocked, cells: [] };
        buckets.set(key, bucket);
      }
      bucket.cells.push(cell);
    }

    for (const bucket of buckets.values()) {
      ctx.globalAlpha = bucket.blocked ? 0.5 : 1;

      ctx.beginPath();
      for (const cell of bucket.cells) addSeatPath(ctx, cell);

      ctx.fillStyle = bucket.fill;
      ctx.fill();
      ctx.strokeStyle = bucket.border;
      ctx.stroke();
    }

    ctx.globalAlpha = 1;

    for (const item of special) {
      addSeatPath(ctx, item.cell, true);
      ctx.fillStyle = item.fill;
      ctx.fill();

      // Selected but unconfirmed. Dashed rather than a third colour: the seat
      // really is selected, and what is open is only whether the server agrees.
      if (item.pending) ctx.setLineDash([3, 2]);
      ctx.strokeStyle = item.border;
      ctx.stroke();
      if (item.pending) ctx.setLineDash([]);

      // The inset ring carries the selected state without relying on colour
      // alone, matching the stylesheet's reasoning.
      if (item.selected || item.pending) {
        ctx.strokeStyle = item.pending ? PENDING_RING : SELECTED_RING;
        ctx.lineWidth = 2;
        ctx.strokeRect(item.cell.x + 2, item.cell.y + 2, item.cell.w - 4, item.cell.h - 4);
        ctx.lineWidth = 1;
      }

      if (item.hovered) {
        ctx.strokeStyle = HOVER_OUTLINE;
        ctx.lineWidth = 2;
        ctx.strokeRect(item.cell.x - 1, item.cell.y - 1, item.cell.w + 2, item.cell.h + 2);
        ctx.lineWidth = 1;
      }
    }

    // Text last, grouped by colour for the same reason the fills are: setting
    // fillStyle between every glyph is a state change per seat.
    if (labels) {
      const byColour = new Map();
      for (const label of labels) {
        const group = byColour.get(label.text) ?? [];
        group.push(label);
        byColour.set(label.text, group);
      }

      for (const [colour, group] of byColour) {
        ctx.fillStyle = colour;
        for (const label of group) {
          ctx.fillText(label.value, label.cell.x + label.cell.w / 2, label.cell.y + label.cell.h / 2 + 0.5);
        }
      }
    }
    ctx.restore();

    const stats = counters();
    if (stats) {
      stats.frames += 1;
      stats.shapesDrawn = drawn;
      stats.shapesTotal = geometry.cells.length;
      stats.lastDrawMs = performance.now() - started;
      // Recorded with the counts, because "312 of 5,000 drawn" means nothing
      // without the zoom it was drawn at.
      stats.scale = view.scale;
      stats.viewport = { width, height };
      // The full transform, not just the zoom. Without the offset a recorded
      // measurement cannot be replayed: "312 of 5,000 at scale 1.65" is only
      // reproducible if you also know which part of the plan was on screen.
      stats.tx = view.tx;
      stats.ty = view.ty;

      // Click to the end of the draw that answers it. Named for what it
      // measures: the browser composites after this returns, so it is not the
      // same instant the DOM baseline's click-to-paint captured. That
      // difference is stated wherever the number is.
      if (clickMarkRef.current !== null) {
        stats.clickToDrawMs.push(performance.now() - clickMarkRef.current);
        clickMarkRef.current = null;
      }
    }
  }, [tree, geometry]);

  const schedule = useCallback(() => {
    frameRef.current ??= requestAnimationFrame(draw);
  }, [draw]);

  // One repaint per commit, coalesced into a frame. The seat map re-renders
  // because a seat changed; this is what turns that into pixels.
  useEffect(schedule);

  // A new layout is a different plan, so the next sizing pass fits it rather
  // than keeping a view that belonged to the old one.
  useEffect(() => {
    fittedRef.current = false;
  }, [geometry]);

  // Size follows the element, and the backing store follows devicePixelRatio —
  // without that the whole plan is soft on any HiDPI screen.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;

      sizeRef.current = { width, height };
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      // Fit once, on the first real size. Re-fitting on every resize would
      // throw away a zoom the visitor chose.
      if (!fittedRef.current) {
        viewRef.current = fitToBounds(geometry.bounds, width, height);
        fittedRef.current = true;
      } else {
        viewRef.current = centreWithin(viewRef.current, geometry.bounds, width, height);
      }

      schedule();
    };

    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [geometry, schedule]);

  useEffect(() => {
    const stats = counters();
    if (stats) stats.quadtree = describeQuadtree(tree);
  }, [tree]);

  // Pointer handling. Non-passive on wheel because zooming must stop the page
  // from scrolling underneath the map.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const localPoint = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const cellAt = (point) => {
      const world = screenToWorld(viewRef.current, point.x, point.y);
      return queryPoint(tree, world.x, world.y);
    };

    const onPointerDown = (event) => {
      const point = localPoint(event);
      pressRef.current = { x: point.x, y: point.y, moved: false };
      canvas.setPointerCapture?.(event.pointerId);
    };

    const onPointerMove = (event) => {
      const point = localPoint(event);
      const press = pressRef.current;

      if (press) {
        const dx = point.x - press.x;
        const dy = point.y - press.y;

        if (!press.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) press.moved = true;

        if (press.moved) {
          const view = viewRef.current;
          const { width, height } = sizeRef.current;

          viewRef.current = centreWithin(
            { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy },
            geometry.bounds,
            width,
            height,
          );

          press.x = point.x;
          press.y = point.y;
          schedule();
          return;
        }
      }

      // Hover. Redrawn only when the seat under the cursor actually changes —
      // a repaint per mousemove would be a frame spent to change nothing.
      const cell = cellAt(point);
      const previous = hoverRef.current;
      if (previous?.key !== cell?.key) {
        hoverRef.current = cell;
        canvas.style.cursor = cell ? 'pointer' : 'grab';
        schedule();
      }
    };

    const onPointerUp = (event) => {
      const press = pressRef.current;
      pressRef.current = null;
      canvas.releasePointerCapture?.(event.pointerId);

      if (!press || press.moved) return;

      const cell = cellAt(localPoint(event));
      if (!cell) return;

      const seat = propsRef.current.seatAt.get(cell.key);

      // Not a seat, or not one that can be taken. The refusal is repeated in
      // useSeatSelection; this only avoids asking for something already known
      // to be refused.
      if (!seat || !isSelectable(seat.status)) return;

      clickMarkRef.current = performance.now();
      propsRef.current.onToggle?.(seat.id);
    };

    const onPointerLeave = () => {
      pressRef.current = null;

      if (hoverRef.current) {
        hoverRef.current = null;
        schedule();
      }
    };

    const onWheel = (event) => {
      event.preventDefault();
      const point = localPoint(event);
      const { width, height } = sizeRef.current;

      const zoomed = zoomAt(viewRef.current, point.x, point.y, WHEEL_ZOOM_STEP ** -event.deltaY);
      viewRef.current = centreWithin(zoomed, geometry.bounds, width, height);
      schedule();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [tree, geometry, schedule]);

  // Clearing the ref matters as much as cancelling the frame. schedule() guards
  // with `??=`, so a stale id left behind here makes it believe a frame is
  // already pending and it never schedules another one — the canvas stops
  // drawing for good. StrictMode mounts, unmounts and remounts every component
  // in development, so this is not a corner case: without the reset the map is
  // blank on arrival, and it would stay blank after any real remount in
  // production too.
  useEffect(
    () => () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="seatmap seatmap--canvas" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="seatmap__canvas"
        // A canvas is one opaque image to a screen reader: there are no seat
        // elements, no focus order and no aria-pressed. Saying so is the honest
        // thing available here — BACKLOG.md P3 keeps parallel keyboard
        // navigation as its own deferred item, and until it is built the DOM
        // renderer is the accessible path.
        role="img"
        aria-label={`Seat map, ${seatAt.size} seats. This view is drawn on a canvas and cannot be navigated with a screen reader or keyboard.`}
      />
      <p className="seatmap__canvas-note">
        Drag to pan, scroll to zoom. A keyboard-navigable seat map is available by building the
        client with <code>VITE_SEAT_RENDERER=dom</code>.
      </p>
    </div>
  );
}
