# Phase 9 — Backlog improvements

Work taken from [`BACKLOG.md`](../../BACKLOG.md) after Phase 8 closed, executed
module by module on `feat/benchmarks`. Part 1 is M1–M4; this document records
what was actually built, verified and measured, in that order.

Phase 8 closed at `c805757`. Nothing in this phase is committed yet.

---

## M1 — Canvas seat map + quadtree

**Backlog item:** P1 *Canvas seat map + quadtree* — scale to ~5,000 seats, a
canvas renderer, quadtree hit-testing, viewport culling, zoom/pan, and the
measurement against the Phase 3 DOM baseline.

### What was built

Four new modules, all pure except the component:

| File | Responsibility |
|---|---|
| `client/src/seatmap/geometry.js` | Layout coordinates → seat rectangles. Mirrors `seatmap.css` so both renderers place seats identically. |
| `client/src/seatmap/quadtree.js` | Static region quadtree. `queryPoint` for hit-testing, `queryRect` for culling. |
| `client/src/seatmap/viewport.js` | The transform stack: `screen = world × scale + translate`, zoom about a point, pan clamping. |
| `client/src/seatmap/SeatCanvas.jsx` | The renderer. Reads selection state, calls `onToggle`, owns no seat state. |

`SeatMap.jsx` gained a renderer selection of about ten lines. Nothing else in
the seat map changed.

### Architecture decisions

**Both renderers ship permanently, behind `VITE_SEAT_RENDERER=canvas|dom`,
defaulting to `canvas`.** `BACKLOG.md` said "replacing the DOM grid"; keeping
both was chosen instead for the same reason `BOOKING_MODE=naive` and
`VITE_SEAT_UPDATE_MODE=immediate` are still here — the DOM grid is the baseline
the canvas is measured against, and a before-number that cannot be re-run is a
claim rather than a measurement. It is also the only accessible path: a canvas
has no seat elements, no focus order and no `aria-pressed`, and canvas
accessibility remains deferred in `BACKLOG.md` P3.

**Geometry and the quadtree depend on the layout alone, never on seat status.**
A seat going from available to booked costs one repaint, not a rebuild of 5,000
rectangles and the tree over them.

**The quadtree is static and hand-written**, with no dependency. Seat geometry
is fixed for the life of a show, so there is no insert-after-build or remove
path. A rectangle straddling a child boundary stays at the parent, which keeps
queries exact without duplicating items and de-duplicating results.

**Seat identity is untouched.** `geometry.js` derives pixels from the layout and
resolves seats through `seatAt` at draw and hit-test time. The `seats` table
remains authoritative and no second source of truth was introduced
(`CLAUDE.md` §10).

**`useSeatSelection.js` was not modified.** Its diff is empty, which was the
gate for calling this a render-layer swap rather than a rewrite.

### Two defects found and fixed during verification

**1. The canvas stopped drawing after any remount.** `schedule()` guards with
`frameRef.current ??= requestAnimationFrame(draw)`. The unmount cleanup
cancelled the pending frame but left the stale id in the ref, so `??=` believed
a frame was already pending and never scheduled another. Under `StrictMode` —
which double-invokes effects in development — this made the map blank on
arrival every time. Fixed by clearing the ref alongside the cancel.

**2. Panning at full zoom-out ran at 8 Hz.** Filling and stroking each seat
separately issues 5,000 paths per frame; rasterising them, not the JavaScript
issuing them, was the cost. Seats are now bucketed by appearance and drawn one
bucket at a time, collapsing 5,000 rectangles into roughly five paths. Selected,
pending and hovered seats — at most seven, given the six-seat ceiling — are
still drawn individually. **The performance effect of this change is NOT
MEASURED**; see the gap recorded below.

### Verification

Everything below was run on the dataset and environment recorded at the end of
this section. Results are labelled PASS / NOT RUN / NOT MEASURED.

| # | Check | Result |
|---|---|---|
| 1 | `quadtree.js` and `geometry.js` unit tests, `npm test` | **PASS** — 26/26 |
| 2 | Client production build | **PASS** |
| 3 | `useSeatSelection.js` content diff empty | **PASS** |
| 4 | Canvas renders 504-seat show (Audi 1, 160 seats): screen band, row labels, seat numbers, aisles after columns 4 and 12, three tier colours matching the legend | **PASS** |
| 5 | Seat click selects exactly the seat under the cursor | **PASS** — click at (664,447) selected E5 |
| 6 | Hold reaches the server | **PASS** — `hold:13:69` present in Redis |
| 7 | Six-seat ceiling; every other seat dims | **PASS** — 6 selected, ₹1,920 |
| 8 | Seventh seat refused | **PASS** — still 6 selected |
| 9 | Deselect releases | **PASS** — 5 selected, ₹1,600 |
| 10 | Hold countdown renders | **PASS** |
| 11 | 5,000-seat stadium renders; labels suppressed below the zoom threshold | **PASS** |
| 12 | Hit-testing under zoom and pan | **PASS** — at scale 3.0, click selected `AR23`, a multi-letter row |
| 13 | Drag pans without selecting | **PASS** — view moved, selection unchanged |
| 14 | Zero DOM seat elements on the canvas path at 5,000 seats | **PASS** — `button.seat` count 0 |
| 15 | DOM renderer still intact under `VITE_SEAT_RENDERER=dom` | **PASS** — 160 buttons, `aria-label="Seat A1, silver, available"`, `aria-pressed="false"`, no canvas |
| 16 | Hold restore from `sessionStorage` after reload | **PASS** — 5 holds re-confirmed and re-selected |
| 17 | Two browsers on separate accounts | **NOT RUN** |

Check 17 was not attempted. F-1 requires a second account to avoid the
test-methodology artifact Phase 8 identified, and a second independent browser
session was not available in this environment. Live updates were exercised only
indirectly, through the hold-restore path.

### Measurements

**Display-rate gate: PASSED.** Phase 7 §5 parked the rAF flush ratio because the
tab measured 24.1 Hz against a 59 Hz panel, so no frame-rate figure is published
here without proving the tab runs at display rate first. Three 2-second native
`requestAnimationFrame` probes in the measuring tab, immediately before the run:

```
59.70 Hz · 59.49 Hz · 59.99 Hz   (120 frames each, visible tab, no shim)
```

#### 1. Components re-rendered per seat click

| | Result | Method |
|---|---|---|
| DOM (Phase 3 baseline) | **5,000**, all 10 trials | React fiber walk via `onCommitFiberRoot` |
| Canvas | **0 `SeatButton` components exist** | Structural: `document.querySelectorAll('button.seat').length === 0` at 5,000 seats |

The canvas figure is **structural evidence, not a profiler measurement**. The
profiling build was not re-run. What is established is that the component whose
5,000 re-renders the baseline counted is not present at all on the canvas path;
what is not established is a like-for-like profiler count of the canvas path's
own commits.

#### 2. Click-to-paint, 5,000 seats

Same procedure as the Phase 3 baseline: the same ten seats
(`A1, C38, F25, I12, K49, N36, Q23, T10, V47, Y34`), one warm-up click
discarded, each trial measured from the click to the **second
`requestAnimationFrame`** after it, selection reset between trials.

| | Median | Range | n |
|---|---|---|---|
| DOM (Phase 3 baseline) | **79.0 ms** | 33.2 – 113.4 ms | 10 |
| Canvas | **36.9 ms** | 26.1 – 41.9 ms | 10 |

Per-trial, in order: 27.2, 35.5, 26.1, 41.9, 37.7, 36.9, 39.9, 36.9, 39.3,
36.5 ms. Every trial selected exactly one seat, so all ten hit their intended
target across all three aisle regions and into multi-letter row labels.

Two things are worth stating plainly. The canvas was measured at fit scale
(0.15) where **all 5,000 seats are drawn** — the worst case for the canvas, and
the same amount of visible content the DOM baseline had. And the tightened range
matters as much as the median: 15.8 ms of spread against 80.2 ms.

#### 3. Shapes drawn vs total — viewport culling

Viewport 1248 × 427 CSS px, devicePixelRatio 1.5, wheel steps of `deltaY = -400`
from the fit view, zooming about the viewport centre.

| Wheel steps | Scale | Drawn | Total | Drawn |
|---|---|---|---|---|
| 0 (fit) | 0.150 | 5,000 | 5,000 | 100 % |
| 1 | 0.273 | 3,200 | 5,000 | 64 % |
| 2 | 0.498 | 1,800 | 5,000 | 36 % |
| 3 | 0.906 | 920 | 5,000 | 18.4 % |
| 4 | 1.651 | 312 | 5,000 | 6.2 % |
| 5 | 3.006 | 84 | 5,000 | 1.7 % |

At the fit view nothing can be culled, because everything is on screen — that is
the honest shape of this metric, not a failure of it. Culling earns its place as
soon as the visitor zooms in at all.

These counts are derived from the transform and the quadtree query, not from a
clock, so they do not depend on frame timing. The table was captured with a
`setTimeout`-driven `requestAnimationFrame` stand-in while the measuring tab was
backgrounded; the same counts were separately confirmed with native
`requestAnimationFrame` in a visible tab during the pan runs below (5,000 /
3,200 / 1,800 / 840 / 288 at the same five scales, the last two differing only
because panning had moved the viewport).

Quadtree over the 5,000-seat layout: **1,329 nodes, 5,000 items, max depth 5**.
Over the 160-seat layout: 21 nodes, 160 items, max depth 2.

#### 4. Frames per second while panning — **superseded, and the re-run is outstanding**

Measured natively in a visible tab on the production build, continuous
pointer-driven pan, 2.5 s per run:

| Scale | Shapes drawn | Pan Hz |
|---|---|---|
| 0.150 | 5,000 | **8.14** |
| 0.273 | 3,200 | 12.94 |
| 0.498 | 1,800 | 22.68 |
| 0.906 | 840 | 14.93 |
| 1.651 | 288 | 40.76 |

A separate three-run set at the fit view gave 7.66, 6.89 and 6.79 Hz. The 0.906
row is out of trend and is reported as measured rather than smoothed; it was not
re-run.

The cost was isolated rather than assumed. Three 2-second loops in the same tab:

| Loop | Hz |
|---|---|
| Pure `requestAnimationFrame`, no events dispatched | 54.85 |
| Dispatching `pointermove` on `document.body` (no handler attached) | 53.49 |
| Dispatching `pointermove` on the canvas | 17.88 |

Synthetic event dispatch is not the bottleneck; the canvas redraw path is. That
is what motivated the bucketed draw described above — and **every number in this
section was measured before that change.** The measuring tab became
unavailable — it is driven by an automation harness and Chrome reports it
`hidden` whenever the window loses foreground, which suspends
`requestAnimationFrame` entirely — before the post-change run could be taken.

**Status: the pan-rate numbers above are the last measured ones, and they
describe the pre-bucketing draw loop. The bucketed draw loop's frame rate is NOT
MEASURED.** Its rendering output was verified visually identical and the unit
tests pass, but no claim is made about its speed. Re-running this table in a
foreground window is the first outstanding task on M1.

#### What these numbers are not

Single-point client-side measurements, one machine, one browser, one viewport,
one dataset. Not throughput, not capacity, not a server benchmark, and not a
statement about any other device. No FPS figure is claimed for the shipped draw
loop.

### Environment

| | |
|---|---|
| Host | Windows 11, Intel Core i7-13620H |
| Browser | Google Chrome 151.0.0.0, canvas viewport 1248 × 427 CSS px, devicePixelRatio 1.5 |
| Client build | production, `npm run build:client`, served by `npm run preview:client` on `:4173` — never the dev server |
| Server | WSL2, Ubuntu 26.04 LTS, Node v22.23.2 |
| Data | Docker `postgres:17-alpine` on 5433, `redis:7-alpine` on 6380 |
| React / Vite | 19.2.8 / 8.2.2 |
| Dataset | `npm run seed:stress` — "Stadium (stress)", 100 rows × 50 = 5,000 seats, show 21 |
| Server flags | `RECONCILE_INTERVAL_SECONDS=0`, `BOOKING_MODE=safe` |
| Date | 2026-08-22 |
| Code | `c805757` plus the uncommitted M1 working tree |

### Reproducing

```bash
docker compose up -d
npm run migrate
npm run seed          # demo dataset
npm run seed:stress   # adds Stadium (stress); prints the show id

CLIENT_ORIGIN=http://localhost:4173 RECONCILE_INTERVAL_SECONDS=0 npm start &
npm run build:client
npm run preview:client            # http://localhost:4173/shows/<id>
```

In the page console, `window.__srSeatRender` carries `frames`, `shapesDrawn`,
`shapesTotal`, `scale`, `tx`, `ty`, `viewport`, `quadtree` and `clickToDrawMs`,
plus `fpsProbe(ms)` for the display-rate gate. Counters only — nothing renders
them and nothing branches on them, the same arrangement Module 6.4 used.

### Known limitations

- **Canvas is invisible to assistive technology.** No seat elements, no focus
  order, no `aria-pressed`. The canvas carries a `role="img"` label that says so.
  `VITE_SEAT_RENDERER=dom` is the accessible path until `BACKLOG.md` P3's canvas
  accessibility item is built.
- **Seat numbers are hidden below scale 0.75, row labels below 0.45.** At
  stadium zoom the glyphs are smaller than the ink drawing them.
- **No pinch-zoom.** Single-pointer pan and wheel zoom only; mobile is
  `BACKLOG.md` P3.
- The pan-rate gap recorded above.

---

## M2 — Observability

**Backlog item:** P2 *Observability — structured logs, request IDs, p50/p95/p99
timing on the booking path.*

### What was built

| File | Responsibility |
|---|---|
| `server/src/lib/metrics.js` | Fixed-bucket duration histograms; `record`, `snapshot`, `resetMetrics` |
| `server/src/middleware/observability.js` | Request ids, one structured line per request, timing on the tracked routes |

`app.js` mounts the middleware first, `health.js` gained `GET /metrics`, and
`env.js` reads `INSTANCE_ID`. No service was touched.

Every number this repository publishes was measured by k6 from outside the
process. Nothing inside the server could say where the time went; this is the
inside view, and it is also what makes M3's multi-instance benchmark
interpretable rather than just "throughput moved".

### Architecture decisions

**No dependency.** `node:crypto.randomUUID`, `console.log(JSON.stringify(...))`
and plain objects. `pino` or `winston` would be the reflex and would buy
nothing here.

**Buckets, not a retained sample array.** Keeping every duration to sort later
is an unbounded allocation on exactly the path that has to survive load — 600
holds a second for a minute is 36,000 numbers per route, growing until the
process dies. The price is resolution: a percentile is the **upper bound of the
bucket** the p-th sample falls into, not the sample itself. That is stated in
the payload itself (`percentile_method`), and count, min, max and mean — which
are exact — are reported beside it.

**Route patterns, never URLs.** The metrics map is the size of the routing
table, not the size of the traffic.

**In-process and per-instance.** No cross-instance aggregation; that is a
monitoring stack, and this is not one. `instance_id` on every line is what makes
several instances separable once M3 lands.

**`/metrics` is refused in production** with 404 — not 403, so a probe cannot
learn the route exists and is merely disabled. Same posture
`paymentService.simulationAllowed()` takes for the payment simulation controls.

**The WebSocket hub is deliberately not instrumented.** M3 rewrites that path
for Redis pub/sub fan-out; instrumenting it now would mean writing it twice and
tangling two diffs.

### A defect found and fixed during verification

**The same route was logged under two different keys.** `routePattern` first
read `req.baseUrl`, which Express **restores as it unwinds the router stack**.
By the time `res.on('finish')` fires it is intact for a handler that responded
normally and empty for one whose error propagated to the app-level error
handler. Measured directly: a 200 logged `/api/shows/:id/seatmap` while a 403 on
the very same router logged `/:id/holds`. That is wrong data *and* the
unbounded-cardinality leak the function exists to prevent — one route would
accumulate two histograms depending on how it happened to fail.

Fixed by reconstructing the prefix from `req.originalUrl`, which is never
rewritten: count the matched route's own segments off the end of it. Re-verified
— a 403 and a 200 on the hold path now produce the identical key.

### Verification

| # | Check | Result |
|---|---|---|
| 1 | `metrics.js` unit tests | **PASS** — 10 tests |
| 2 | Whole suite (`npm test`) | **PASS** — 36/36 |
| 3 | Request id generated and echoed in `X-Request-Id` | **PASS** |
| 4 | Well-formed inbound id honoured | **PASS** — `my-trace-123` echoed and logged |
| 5 | Malformed inbound id rejected, fresh UUID minted | **PASS** — value with spaces refused |
| 6 | Route patterns collapse: four different show ids | **PASS** — one key, `count: 6` |
| 7 | Unmatched request contributes no URL | **PASS** — `(unmatched)`, level `warn` |
| 8 | Same route, success and error, one key | **PASS** — after the fix above |
| 9 | All four tracked paths record | **PASS** — seatmap, hold, release, bookings |
| 10 | `/metrics` refused under `NODE_ENV=production` | **PASS** — 404, `/health` still 200 |
| 11 | Nothing sensitive in logs | **PASS** — 0 matches for password/email/authorization/cookie/token/secret across a login, holds, releases and a booking |
| 12 | Levels track status | **PASS** — 200 `info`, 403/404 `warn` |
| 13 | Instrumentation overhead | **PASS — no measurable overhead**, below |

### Overhead measurement

The one question worth measuring: does the instrumentation itself distort the
path every other measurement in this repository depends on? A/B on one harness,
three runs each, server restarted between conditions, `RECONCILE_INTERVAL_SECONDS=0`.
The control was produced by commenting out the `app.use(observability)` line;
`app.js` was restored from a backup afterwards and verified byte-identical.

| Condition | Holds/sec per run | Mean | Hold latency mean per run |
|---|---|---|---|
| Instrumentation **OFF** | 146.5 · 166.9 · 170.9 | **161.4** | 70.8 · 62.9 · 61.4 ms |
| Instrumentation **ON** | 146.8 · 150.4 · 171.1 | **156.1** | 70.5 · 68.0 · 60.7 ms |

**The difference is inside run-to-run noise.** The gap between conditions is
3.3 % of mean throughput; the spread *within* each condition is ~16 %, and the
two ranges are almost exactly coincident (146.5–170.9 against 146.8–171.1). Both
conditions show the same warm-up shape, the first run being the slowest. No
overhead is claimed to have been detected, and none is claimed to be absent
beyond what this sample size can see.

Every run: 0 conflicts and 0 failures, so the load was uncontended by
construction and valid.

> **The driver was not k6.** k6 is not installed in this environment, so the A/B
> was run with a temporary Node driver — `m2-overhead.mjs`, kept in the session
> scratchpad and **not** added to the repository — that mirrors
> `hold-throughput.js`'s uncontended design (disjoint seat slices per worker).
> This is defensible for a *relative* delta on an identical harness, which is
> the only question being asked. **These absolute numbers are not comparable to
> the Phase 7 figures and are not recorded in `loadtest/results/`.** If you want
> the control repeated with the real tool, install k6 and re-run
> `loadtest/hold-throughput.js` with the middleware mounted and unmounted.

### Environment

| | |
|---|---|
| Server | WSL2, Ubuntu 26.04 LTS, Node v22.23.2 |
| Data | Docker `postgres:17-alpine` on 5433, `redis:7-alpine` on 6380 |
| Host | Windows 11, Intel Core i7-13620H |
| Load | 20 workers × 4 seats, 15 s per run, 3 runs per condition, show 21 (5,000 seats) |
| Flags | `RECONCILE_INTERVAL_SECONDS=0`, `BOOKING_MODE=safe` |
| Date | 2026-08-22 |
| Code | `c805757` plus the uncommitted M1 + M2 working tree |

### What it looks like

```json
{"ts":"2026-08-22T17:48:45.467Z","level":"info","instance_id":"m2-final",
 "req_id":"9b994328-e9c2-4559-93f2-4a06e27d6402","method":"GET",
 "route":"/api/movies","status":200,"duration_ms":8.25}
```

```bash
curl -s http://localhost:3000/metrics
```

### Known limitations

- **Percentiles are bucket-resolution**, not exact. Count, min, max and mean are
  exact.
- **Per-instance only.** No aggregation across processes.
- **Metrics reset when the process restarts.** There is no persistence, by
  design — this is a benchmarking and debugging surface, not a monitoring
  system.
- **The WebSocket path is uninstrumented** until M3.
- The overhead control was not run with k6, as recorded above.

---

## M3 — Multi-instance fan-out over Redis pub/sub

**Backlog item:** P2 *Multi-instance deployment — 2-3 Node instances behind a
load balancer, Redis pub/sub for WebSocket fan-out. Verify holds and bookings
stay correct across instances.*

### What was built

| File | Responsibility |
|---|---|
| `server/src/realtime/seatChannel.js` | Transport only. Publish a message, hand a message back. Knows nothing about rooms, sockets or seat status. |
| `server/src/realtime/hub.js` | Rooms stay local; the *news* crosses the instance boundary. `deliverSeats` is the only place a frame is written. |
| `server/src/db/redis.js` | `createSubscriber()` — a second connection, because a client in subscribe mode cannot issue ordinary commands. |
| `server/src/index.js` | Starts the subscriber after the listener is up, deliberately not awaited. |
| `server/src/routes/health.js` | `seat_events` on `/metrics` — instance id, channel state, rooms, sockets. |
| `docker-compose.yml`, `docker/nginx.conf` | Three instances behind nginx, behind a `multi` profile. Local only; `render.yaml` untouched. |

### Architecture decisions

**One channel, not one per show.** Per-show channels would mean subscribing and
unsubscribing as rooms open and close, and a race every time the last watcher of
a show disconnects while a broadcast is in flight. The cost is that every
instance sees every message and filters by show id — a Map lookup per instance
per seat change.

**The origin does not deliver locally.** `broadcastSeats` publishes and returns;
the message comes back through this instance's own subscriber and is delivered
from there, alongside every remote instance's copy. An origin that also
delivered directly would have two delivery paths to keep in step, and the first
bug in that arrangement is a socket told the same thing twice. Verified below at
exactly one frame in every arrangement, including the same-instance case where a
double delivery would have shown up.

**Status is resolved once, at the origin, and the answer travels.** Publishing
bare seat ids and letting each instance resolve them would multiply the read by
the instance count. `availabilityService` remains the only thing that answers
"is this seat taken" — it is asked once instead of N times, so no second
availability path is introduced (`CLAUDE.md` §10).

**No sticky sessions, and that is a property of the protocol.** The seat socket
is server-to-client only and its show is fixed at upgrade time, so a connection
carries no state an instance could own. Round-robin is correct, not merely
tolerable. `docker/nginx.conf` is plain round-robin, and the verification below
deliberately puts watcher and writer on different instances throughout.

**The empty-room early return is gone, and that is a measured regression.** It
used to skip the availability read when this instance had no watchers, but an
instance cannot know whether some other instance has one. What it costs is
measured below rather than guessed at.

### Verification

Environment at the end of this section. Labels are PASS / NOT RUN.

**Topology**

| # | Check | Result |
|---|---|---|
| 1 | `--profile multi` brings up three instances plus nginx; plain `up -d` still starts Postgres and Redis only | **PASS** — profile isolation intact |
| 2 | Each instance reports its own id and `cross_instance: "ok"` | **PASS** — app1 / app2 / app3 |
| 3 | nginx round-robins | **PASS** — six requests to `:8080/metrics` returned app1, app2, app3, app1, app2, app3 |
| 4 | `X-Request-Id` survives the proxy | **PASS** — `m3-trace-001` supplied at `:8080`, logged by app3 |
| 5 | Wrong-`Origin` upgrade through nginx | **PASS** — 403 |
| 6 | Unknown show upgrade through nginx | **PASS** — 404 |

**Delivery and exactly-once.** Frames counted over a 3-second window after a
single action, per watcher.

| # | Check | Result |
|---|---|---|
| 7 | Cross-instance hold — watcher app3, writer app1 | **PASS** — 1 frame, both seats `held` |
| 8 | **Same-instance** hold — watcher app1, writer app1 | **PASS** — **1 frame**, not 2 |
| 9 | Three watchers, one per instance, writer app2 | **PASS** — **1 frame each**, not 3 |
| 10 | Cross-instance release | **PASS** — 1 frame, `available` |
| 11 | Cross-instance booking creation | **PASS** — 1 frame, `booked` |
| 12 | Show isolation — watcher on another show | **PASS** — 0 frames |
| 13 | Payment-confirm broadcast | **NOT RUN** — the same `broadcastSeats` call site as 10 and 11, exercised through hold, release and booking but not through a payment event |

**Redis failure and recovery**

| # | Check | Result |
|---|---|---|
| 14 | All three instances survive Redis stopping | **PASS** — no process exited |
| 15 | `cross_instance` reports honestly | **PASS** — `local-only` on all three |
| 16 | `/health` while Redis is down | **PASS** — 503 `db=ok redis=error`, in **5.0 s** (see limitations) |
| 17 | Holds fail closed | **PASS** — 503 `HOLDS_UNAVAILABLE` |
| 18 | Seat map still served | **PASS** — 200, holds not merged, `availabilityService` degrading as designed |
| 19 | **Local fallback delivers** — same-instance watcher, booking written while the channel is down | **PASS** — 1 frame |
| 20 | Cross-instance watcher, channel down | **PASS** — 0 frames; expected and documented, not a defect |
| 21 | Postgres still refuses the second sale | **PASS** — 409 `SEATS_UNAVAILABLE` |
| 22 | Recovery after Redis restarts | **PASS** — `cross_instance` back to `ok` within ~8 s, and **re-verified functionally**: checks 7–12 were re-run and all passed, without restarting any instance |
| 23 | Unit tests | **PASS** — 42/42, including six new `seatChannel.js` tests |

Check 22 was verified by behaviour rather than by the flag on purpose:
`cross_instance` reads a `subscribed` boolean that is set once, so it could in
principle report `ok` for a subscription that had been lost. Re-running the
delivery trials is what establishes that it had not.

### Measurement — what the fan-out costs

The question the removed early return raises: what does it cost to resolve seat
status on every change, whether or not this instance has a watcher? Measured
with `loadtest/hold-throughput.js`, **unchanged**, at the configuration Phase 7
§7.3a used — show 21 (5,000 seats), 50 VUs × 4 seats, 45 s, `WATCHERS=0`,
`RECONCILE_INTERVAL_SECONDS=0`, `BOOKING_MODE=safe`. Three runs per condition,
every run with **0 conflicts and 0 failures**, so every run was uncontended by
construction and valid.

| Condition | Topology | Runs (holds/sec) | Mean | Hold latency avg | p95 |
|---|---|---|---|---|---|
| **Phase 7 baseline** | host, single instance, **pre-M3 code** | 499.5 (n=1, 2026-08-22) | **499.5** | 54.6 ms | — |
| **A** | host, single instance, **M3 code** | 384.6 · 395.0 · 400.5 | **393.4** | 71.9 ms | 98.8 ms |
| **C** | one **container** instance, direct | 374.3 · 359.1 · 351.6 | **361.7** | 77.0 ms | 108.2 ms |
| **B** | **three** instances behind nginx | 331.3 · 344.6 · 346.6 | **340.8** | 83.1 ms | 172.3 ms |

Read as three separate steps rather than as one number:

- **A vs the Phase 7 baseline: −21.2 %.** The cost of the M3 change on the
  topology Phase 7 measured — the always-on availability read plus the publish.
  It is the price of the correctness property that a hold taken on one instance
  reaches a watcher on another.
- **C vs A: −8.1 %.** Containerisation and the published port, not the fan-out.
  This condition exists so that cost is not silently attributed to M3.
- **B vs C: −5.8 %**, with p95 hold latency rising from 108 ms to 172 ms — the
  nginx hop, round-robin, and every instance parsing every published message.

**Three instances did not raise hold throughput, and that is the honest result.**
This workload is bound by the shared Postgres and Redis and by a single load
generator, not by Node CPU on one process, so spreading it over three processes
adds hops without removing the constraint. The `pg` pool ceiling of 10 per
instance (`BACKLOG.md` F-2) is unchanged and still un-sized. What multi-instance
buys here is availability and correct fan-out, **not** throughput; a throughput
claim from this evidence would be a claim this repository has not measured.

For condition A the three container instances were **stopped**, so their idle
subscribers could not parse every published message and depress the number. B
and C reach the server through a Docker-published port while A and the Phase 7
baseline do not — which is exactly why C is here.

#### What these numbers are not

One machine, one load generator, one dataset, three runs per condition. Not
capacity, not a production figure, and not a statement that three instances are
slower than one in general — only that they are, on this hardware, for this
workload, against one shared database. The Phase 7 baseline is a **single run
from 2026-08-22**; it was not re-run, so part of the A delta could be machine
state rather than code. A more precise attribution would need the pre-M3 code
re-run today, which would mean reverting the M3 diff.

### Environment

| | |
|---|---|
| Host | Windows 11, Intel Core i7-13620H |
| Server | WSL2, Ubuntu 26.04 LTS, Node v22.23.2 |
| Instances | `node:22-alpine`, repository bind-mounted, `INSTANCE_ID` app1/app2/app3 |
| Balancer | `nginx:1.27-alpine`, round-robin, no sticky sessions, `:8080` |
| Data | Docker `postgres:17-alpine` on 5433, `redis:7-alpine` on 6380 |
| Load | k6 v2.2.0, from WSL |
| Dataset | `npm run seed:stress` — show 21, 5,000 seats |
| Flags | `RECONCILE_INTERVAL_SECONDS=0`, `BOOKING_MODE=safe` |
| Date | 2026-08-31 |
| Code | `c805757` plus the uncommitted M1 + M2 + M3 working tree |

### Reproducing

```bash
docker compose up -d                             # Postgres + Redis only
docker compose --profile multi up -d --build     # app1..app3 + nginx on :8080

curl -s localhost:3001/metrics                   # per-instance seat_events

BASE_URL=http://localhost:8080 SHOW_ID=21 VUS=50 SEATS_PER_VU=4 \
  DURATION=45s WATCHERS=0 k6 run loadtest/hold-throughput.js
```

The delivery and degradation checks were driven by two temporary Node scripts
using the repository's existing `ws` dependency. Following the precedent M2 set
for its own driver, they were **kept in the session scratchpad and not added to
the repository**, and no raw k6 summary was added to `loadtest/results/`. The
per-run figures above are the k6 end-of-test summaries from that session; the
retained scratchpad JSON is the third run of each condition.

### Known limitations

- **`/health` takes 5.0 s to answer while Redis is down**, because the Redis
  ping has no timeout of its own. Pre-existing behaviour that M3 did not touch
  and did not fix, though it is more visible with three instances behind a
  health-checking balancer. Outside M3's scope.
- **A single-message window remains.** `seatChannelReady()` is checked before
  publishing, so a channel that drops between the check and the publish can lose
  that one message. Inherent to publishing without an acknowledgement; not
  observed in any run above.
- **`cross_instance` is a state flag, not a probe.** It reports what an instance
  believes; check 22 is what tests the belief.
- **No cross-instance metrics aggregation.** `/metrics` stays per-process.
- **Local only.** `render.yaml` is untouched and the deployed service is still a
  single instance. Merging and deploying remain separate, unmade decisions.
- **The payment-confirm broadcast was not exercised** (check 13).
- One-off and **not reproduced**: in the first seconds after the Redis container
  stopped, one `/health` sample reported `db=error` and one WebSocket upgrade
  returned 503. Neither recurred once the stack settled, and both were re-tested
  deliberately. Recorded rather than explained away.

---

## M4 — Rate limiting on hold creation

**Backlog item:** P2 *Rate limiting on hold creation — one user shouldn't be
able to hold a whole screen.*

### What was built

| File | Responsibility |
|---|---|
| `server/src/middleware/rateLimit.js` | A fixed window counted in Redis, per user. The whole mechanism. |
| `server/src/config/env.js` | `HOLD_RATE_LIMIT`, `HOLD_RATE_WINDOW_SECONDS` |
| `server/src/routes/shows.js` | One middleware added to `POST /:id/holds`. Nothing else. |

`holdService`, `availabilityService`, the booking transaction and every payment
path are untouched. The limiter sits at the request boundary and the handler
below it does not know it exists.

### Architecture decisions

**Redis, not a Map in this process.** After M3 there are several instances
behind a load balancer with no sticky sessions. An in-process counter would give
one user the limit *per instance*, so a three-instance deployment would silently
enforce three times what it advertises. Verified below: the budget is shared.

**Per user, not per IP.** The thing being prevented is one account holding a
whole screen. An IP is not an account, and behind a proxy it is not even a
stable client. The route already requires auth, so the user id is free.

**Requests, not seats.** A request is what costs the server work, and the
six-seat ceiling already bounds seats per request. Counting seats would
duplicate a rule that already lives in two other places.

**Creation only.** `DELETE /:id/holds` is deliberately unlimited: releasing a
hold gives seats back, and rate limiting the way out of a mistake would be the
wrong rule.

**A fixed window, and its weakness is stated rather than hidden.** A user can
spend the limit at the end of one window and again at the start of the next, so
the true worst case is 2× the limit across a window boundary. A sliding window
means a timestamp per request per user — more memory and more moving parts than
this is worth. The limit exists to stop one account sweeping a screen, not to
meter billing.

**Atomic by Lua**, the same shape `holdService` uses. `INCR` then `EXPIRE` as
two round trips leaves a window where a process dying between them strands a key
with no TTL — and a key with no TTL is a user locked out permanently.

**Fails open.** If Redis cannot be reached the request is allowed through, and
`holdService` refuses it a moment later with 503 `HOLDS_UNAVAILABLE`, because
holds are already a hard Redis dependency. Failing closed would change nothing
except which error the user sees, while adding a way for a limiter fault to take
down a path that was working.

**0 disables it**, exactly as `RECONCILE_INTERVAL_SECONDS=0` disables the sweep.
This is not a loophole, it is a requirement: a hold benchmark drives hundreds of
requests a second as a single user, so every existing hold measurement in this
repository must be re-run with `HOLD_RATE_LIMIT=0` or it would be measuring the
limiter. Recorded in `.env.example` next to the variable.

### Verification

| # | Check | Result |
|---|---|---|
| 1 | Unit tests — key shape, per-user scoping, limiter enabled by config, fail-open with no Redis, no `Retry-After` when failing open | **PASS** — 4 tests |
| 2 | Whole suite | **PASS** — 46/46 |
| 3 | Limit binds on one instance — 40 sequential requests, limit 30/60 s | **PASS** — 30 × 201 then 10 × 429, first refusal at request 31 |
| 4 | The refusal is well formed | **PASS** — `429 RATE_LIMITED`, `Retry-After: 60` |
| 5 | **Budget shared across instances** — same 40 requests through nginx, round-robined across app1/app2/app3 | **PASS** — still 30 × 201 and 10 × 429, **not 90**; all three instances served part of the run |
| 6 | Releases are not limited | **PASS** — 10 × `DELETE` returned 200 while the user was over the limit |
| 7 | Per-user isolation | **PASS** — a second account got its own full 30 while the first was still being refused; only that account's key existed in Redis |
| 8 | `HOLD_RATE_LIMIT=0` disables | **PASS** — 40/40 accepted, and **zero** counter keys written, so a disabled limiter costs nothing |
| 9 | Behaviour when Redis is down | **PASS by unit test** (fail-open) — **NOT RUN** end to end, because the hold path already 503s without Redis, so the limiter's branch is unobservable from outside |

Checks 3–8 were driven by a temporary Node script kept in the session
scratchpad and not added to the repository, the precedent M2 and M3 both set.

### No measurement is published

The backlog item names no metric, and none is claimed. Throughput was **not**
re-measured for this module: the limiter is off in every benchmark
configuration by construction, so a hold-throughput run with it enabled would
measure the refusal path rather than the hold path. The cost when disabled is
one comparison against a config value and no Redis call — check 8 confirms no
key is written.

### Environment

| | |
|---|---|
| Host | Windows 11, Intel Core i7-13620H |
| Server | WSL2, Ubuntu 26.04 LTS, Node v22.23.2 |
| Instances | three `node:22-alpine` containers behind `nginx:1.27-alpine` on `:8080` |
| Data | Docker `postgres:17-alpine` on 5433, `redis:7-alpine` on 6380 |
| Config | `HOLD_RATE_LIMIT=30`, `HOLD_RATE_WINDOW_SECONDS=60` (defaults) |
| Dataset | show 21, 5,000 seats |
| Date | 2026-08-31 |
| Code | `c805757` plus the uncommitted M1 + M2 + M3 + M4 working tree |

**Test data:** verifying per-user isolation required a second account, so
`m4-limit@show-rush.dev` (user id 5) was registered in the local compose
database. It exists only there.

### Known limitations

- **Fixed-window boundary**: up to 2× the limit across two adjacent windows.
- **No limit on booking creation, payment confirmation, or the auth endpoints.**
  Only hold creation is limited; the rest stay as `BACKLOG.md` records them.
- **The limit is not advertised before it is hit** — no `X-RateLimit-*` headers
  on successful responses, only `Retry-After` on a refusal.
- **Every existing hold benchmark must set `HOLD_RATE_LIMIT=0`.** The recorded
  Phase 2, 5, 6 and 7 numbers predate this module and were measured without it;
  none was re-run.
- **The Redis-down path is unit-tested, not exercised end to end** (check 9).
