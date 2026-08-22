# Phase 7 — Benchmarks

**Status:** IMPLEMENTED and MEASURED. Verification passed (§8). **Not committed,
not merged.** Stopped at the Module 7.3b approval gate (§7).
**Branch:** `feat/benchmarks`, cut from `feat/reconciliation` @ `7902b8a`
**Source of truth:** `PLAN.md` §Phase 7, `BACKLOG.md`, `docs/phases/phase-6-reconciliation.md`
**Rules:** `CLAUDE.md` — not restated here
**Plan approved:** 2026-08-22 — decisions D-1…D-4 in §2
**Close-out written:** 2026-08-22, after the single verification pass

---

## 1. Objective

`PLAN.md` Phase 7 asks for one committed script per claim, run properly against
the local Docker stack, with every number carrying its command, environment and
commit; findings reported and nothing fixed without approval; and a results table
that labels single-point measurements as such.

**Phase 7 changed no application code, no schema and no dependencies.** Every
module is a script, a run, or a document. That is what makes "Phase 7 must not
quietly rewrite Phase 1" structurally true rather than merely promised.

## 2. Decisions taken before implementation

- **D-1** Phase 2's before/after and Phase 5's replay were **re-run at the Phase 7
  commit** rather than cited from their original runs, so every row in §6 shares
  one commit. The historical 2026-08-19/21 numbers are kept and reported
  **separately** — see §3.1, which states explicitly that the two sets were not
  produced under identical conditions.
- **D-2** Module 7.3a **reports only**. Nothing was fixed. One approval gate, §7.
- **D-3** Availability latency measured on **both** datasets — the seeded screen
  and the 5,000-seat stress screen.
- **D-4** The owed Module 6.4 rAF measurement was attempted with a
  human-driven foreground browser. It is **PARKED UNRESOLVED** — see §5.

## 3. Environment

Every recorded run in this document shares this environment unless stated.

| | |
|---|---|
| Machine | VIVEK-LAPTOP-3VEE2JPV, WSL2 (kernel 6.18.33.2-microsoft-standard-WSL2), **4 cores**, 6 GB WSL memory cap |
| Node | **v22.23.2** (pinned via `.nvmrc`/`engines`), npm 10.9.8 |
| k6 | **v2.2.0** (`commit/00a9a1b7f5, go1.26.5, linux/amd64`) |
| Postgres | **17.11** — Docker `showrush-postgres`, published on `localhost:5433` |
| Redis | **7.4.10** — Docker `showrush-redis`, published on `localhost:6380` |
| Commit | `feat/benchmarks`, parent `7902b8a` — **working tree, uncommitted at measurement time** |
| Server | `NODE_ENV=development`, single instance, `pg` pool `max` **unset → 10** |
| Sweep | **`RECONCILE_INTERVAL_SECONDS=0` on every run, without exception** |
| Isolation | `read committed` — asserted and logged by the server at first booking |
| Where | Repository, Node and k6 all inside WSL; Docker publishes to Windows `localhost`. No run split across the boundary |

**Also running on the same host, and recorded rather than hidden:** the unrelated
`collab-postgres` (`:5432`) and `collab-redis` (`:6379`) containers, and three
leftover Phase 2 databases on the same Postgres instance — `showrush_baseline`,
`showrush_25`, `showrush_repro`. The latter two are idle and were never touched;
they consume disk, not CPU. Their presence is stated because "what else was on
the box" is part of a method.

### 3.1 The historical Phase 2 numbers are a separate measurement

`README.md` records **303 · 150 · 303** double-bookings from 2026-08-19. Those
were produced on a different commit, before migrations `003` and `004`, before
the reconciliation sweep existed, and before `bookingService` broadcast on
success. **They are not combined with the Phase 7 re-runs anywhere**, and no
range spans both sets. Two independent measurements of the same property, each
carrying its own commit and date.

## 4. Measurements

### 4.1 Booking concurrency — Module 7.2b

500 VUs, one seat, one show, released together behind a 3 s barrier.
`loadtest/seat-contention.js`, counted by `loadtest/count-double-bookings.sql`.

**Before — `BOOKING_MODE=naive`**, against a disposable `showrush_baseline`
database at schema `001` only (no unique constraint), re-seeded between runs:

| Run | 201 created | 409 | **double-bookings** | dropped | 5xx | `http_req_failed` |
|---|---|---|---|---|---|---|
| 1 | 380 | 120 | **379** | 0 | 0 | 0.00% |
| 2 | 306 | 194 | **305** | 0 | 0 | 0.00% |
| 3 | 380 | 120 | **379** | 0 | 0 | 0.00% |

**Range: 305–379 seats sold twice, over 3 runs.** Stochastic, as Phase 2
documented; the run count is stated because a single figure from a stochastic
process is a sample presented as a constant.

> **Disclosure — a fourth naive run was discarded.** An earlier attempt at run 2
> produced **478** × 201-created, but its `count-double-bookings.sql` output was
> lost to an output-filtering mistake before being read, and its summary was
> overwritten by the re-run. Its double-booking count was **never measured** and
> is **not** inferred from the creation count. It is disclosed because its
> creation count was **higher than all three recorded runs**, so the true spread
> is likely **wider** than 305–379. The recorded range is not the full range.

**After — `BOOKING_MODE=safe`**, against `showrush` at all four migrations:

| Run | 201 created | 409 | **double-bookings** | dropped | 5xx |
|---|---|---|---|---|---|
| 1 | 1 | 499 | **0** | 0 | 0 |
| 2 | 1 | 499 | **0** | 0 | 0 |
| 3 | 1 | 499 | **0** | 0 | 0 |

Exactly one winner, 499 clean 409s, three times. The constraint either holds or
it does not, so 0 is not stochastic in the way the before-number is.

Raw: `loadtest/results/7.2b-{naive,safe}-2026-08-22-{1,2,3}.json`.

### 4.2 Payment replay — Module 7.2c

`loadtest/webhook-replay.js`, counted by `loadtest/count-payment-replay.sql`.
**500 VUs × 20 iterations = 10,000 attempts at a concurrency of 500** — that is
what this machine can produce, and it is *not* 10,000 simultaneous connections.

| | |
|---|---|
| 201 created | **1** |
| 200 duplicate | **9,999** |
| 409 / other 4xx / 5xx / no response | 0 / 0 / 0 / 0 |
| dropped_iterations | 0 |
| `http_req_failed` | 0.00% |
| latency | avg 379.1 ms · p95 442.6 ms · max 700.8 ms |
| **`payment_events` rows for the event** | **1** |
| booking status | `paid`, 1 seat row, no extras |

`PLAN.md`'s second non-negotiable, re-confirmed at the Phase 7 commit.
Raw: `loadtest/results/7.2c-replay-2026-08-22.json`.

### 4.3 Hold throughput — Module 7.2d

`loadtest/hold-throughput.js`, **uncontended by construction**: every VU gets a
disjoint seat slice, and any 409 invalidates the run. Against the 5,000-seat
stress show. **Single-point measurement — no before/after.**

| | VUS=50 | VUS=200 |
|---|---|---|
| iterations (hold+release cycles) | 36,420 | 35,630 |
| **holds/sec** | **605.3** | **590.9** |
| releases/sec | 605.3 | 590.9 |
| hold latency | avg 45.4 · med 44.4 · p95 58.5 · p99 70.1 · max 251.2 ms | avg 198.3 · med 195.5 · p95 227.1 · p99 249.9 · max 476.9 ms |
| release latency | avg 36.8 · p95 47.9 · p99 57.3 ms | avg 138.7 · p95 160.8 · p99 177.5 ms |
| 409 conflicts | **0** | **0** |
| dropped / failed | 0 / 0 | 0 / 0 |

**The system is saturated at roughly 600 holds/sec on this hardware.** Four times
the concurrency produced no additional throughput and multiplied latency by ~4.4
— the signature of a queue, not of headroom.

**Repeatability:** two runs at VUS=50 taken minutes apart gave **586.4** and
**608.8** holds/sec, so treat ~600/s as ±4% on this machine rather than a
constant.

Raw: `loadtest/results/7.2d-holds-2026-08-22-vus{50,200}.json`.

### 4.4 Availability query latency — Module 7.2e

`loadtest/availability-latency.js` — `GET /api/shows/:id/seatmap`, the one
availability read path: one Postgres query plus one Redis `MGET` whose width is
the seat count. `constant-arrival-rate` at 50/s for 60 s. **Anonymous**, so the
`optionalAuth` viewer-specific merge is **not** covered by these numbers.
**Single-point measurements — no before/after.**

| Dataset | seats (MGET width) | pre-held | avg | med | p95 | p99 | max | dropped |
|---|---|---|---|---|---|---|---|---|
| seeded screen | 160 | 0 | **7.5** | 7.6 | 9.4 | 10.8 | 23.9 | 0 |
| seeded screen | 160 | 50 | **6.7** | 7.0 | 9.0 | 10.0 | 18.9 | 0 |
| stress screen | 5,000 | 0 | **18.5** | 17.5 | 24.1 | 35.6 | 65.8 | 0 |
| stress screen | 5,000 | 500 | **18.4** | 17.5 | 23.3 | 34.1 | 63.1 | 0 |

All in milliseconds. Achieved rate 48.6–50.0/s against 50/s offered, so the load
landed.

**31× the seats costs ~2.5× the latency** — the query and merge scale far better
than linearly in seat count. **Pre-holding seats made no measurable difference**
(within run-to-run noise), which is expected: `MGET` answers a hit and a miss over
the same round trip.

Raw: `loadtest/results/7.2e-availability-2026-08-22-{normal,stress}-{cold,held}.json`.

## 5. Module 6.4 rAF re-measurement — **PARKED, UNRESOLVED**

Phase 6 owed a visible-tab rAF number: its recorded run was taken in a
permanently hidden tab and therefore measured the 1 s fallback clock. Phase 7
attempted it with a human-driven foreground browser.

**Both halves ran, and message delivery was perfect. The flush ratio is NOT
recorded as a display-rate rAF result, because the rAF cadence could not be
established.**

Workload identical on both sides: `SHOW_ID=20 VUS=15 SEATS_PER_VU=2 STEP_MS=50
DURATION=20s`, show 20 (84 seats), one foreground tab, `document.visibilityState`
confirmed `"visible"` throughout both runs. Socket validated 1:1 immediately
before each run with a deliberate 2-broadcast burst.

| | `immediate` | `batched` |
|---|---|---|
| counter baseline | 2 / 2 / 2 | 2 / 2 / **1 or 2** (flushes not read) |
| counter after | 4980 / 9958 / 4980 | 4774 / 9546 / 14 |
| **Δ messages** | **4,978** | **4,772** |
| broadcasts k6 caused | 4,978 | 4,772 |
| **message loss** | **zero** | **zero** |
| Δ seatUpdates | 9,956 (= 2 × messages) | 9,544 (= 2 × messages) |
| **Δ flushes** | **4,978** | **12–13** |

**What is established.** Every broadcast the server emitted was received by the
browser, on both runs — 4,978 and 4,772, exact matches. `immediate` performs
**exactly one flush per message** (1,000 per 1,000). Batching demonstrably
collapses many messages into few flushes. The direction and mechanism are
confirmed.

**Why no ratio is recorded.** 14 flushes across 20 s is ~0.7 flushes/second. A
foreground tab at display rate would offer ~1,200 frames in that window, and with
~238 messages/second arriving, nearly every frame should have had something to
flush. A direct probe of the tab measured **24.1 Hz idle** — already well below
the panel's **59 Hz** — and the loaded cadence implied by 14 flushes is lower
still, close to the ~1 Hz regime that Phase 6's discredited hidden-tab run
(11 flushes) sat in.

**This matters to the headline and is why it is parked.** At a true ~60 Hz the
batched run would show flushes in the hundreds and the ratio would be roughly
**4:1**. At the observed cadence it computes to roughly **380:1**. Same code, same
workload, two irreconcilable claims — and only one can be true. Publishing the
larger number would repeat precisely the error Phase 6 made.

**Ruled out as causes of the degraded cadence**, by read-only inspection:

- Display: Intel UHD, 1920×1200, **59 Hz** (min 59, max 59) — not a 24 Hz panel.
- Power: **on AC**, 76%, Balanced plan — not battery throttling.
- Chrome: Canvas, compositing, rasterization and WebGL/WebGPU all **hardware
  accelerated**; Energy Saver and Memory Saver **disabled**.
- Host CPU: load average **0.05** at probe time — not contention, despite this
  being a 4-core box running Postgres, Redis, Node, Vite and Chrome.
- Stray load: no k6 process running; Redis stable at 0 keys across samples.

**Remaining candidates, none confirmed:** window occlusion (Chrome throttles rAF
hard for an occluded window while `visibilityState` still reports `"visible"`),
DevTools influence, or main-thread saturation under a ~238 msg/s arrival rate.
Distinguishing them needs further browser-side work that was deliberately not
pursued.

**Status: the rAF number PLAN.md 6.4 asked for is still owed.** Phase 7 did not
produce it and does not estimate it. Raw summaries of both runs are kept —
`loadtest/results/6.4-{immediate,batched}-visible-2026-08-22.json` — and they are
generator-side counts only.

## 6. Results table — Module 7.4

Every row: local Docker stack, `RECONCILE_INTERVAL_SECONDS=0`, commit
`feat/benchmarks` @ `7902b8a` (working tree), 2026-08-22, environment §3.

| Metric | Before | After | Method / workload | Script |
|---|---|---|---|---|
| **Seats sold twice** (500 VUs, one seat) | **379 · 305 · 379** (`naive`, schema 001) | **0 · 0 · 0** (`safe`, +`002`) | 3 runs each, re-seeded between; range reported | `seat-contention.js` |
| **Bookings from one replayed event** | — *single-point* | **1** from 10,000 attempts @ 500 concurrent | 500 VUs × 20 iters | `webhook-replay.js` |
| **Hold throughput** | — *single-point* | **605 holds/s** @ 50 VUs · **591/s** @ 200 VUs | uncontended, disjoint slices, 5,000-seat show, 60 s | `hold-throughput.js` |
| **Availability latency, 160 seats** | — *single-point* | **7.5 ms avg · 9.4 p95** | anonymous, 50/s for 60 s | `availability-latency.js` |
| **Availability latency, 5,000 seats** | — *single-point* | **18.5 ms avg · 24.1 p95** | anonymous, 50/s for 60 s | `availability-latency.js` |
| **Broadcast cost per seat change** | **499 holds/s** (0 watchers) | **373/s** (1 watcher) · **238/s** (50 watchers) | same workload, watchers varied | `hold-throughput.js` + `ws-fanout.js` |
| **WebSocket memory, 100→1000 sockets** | — *single-point* | **no growth observed**; RSS settles ~96 MB, flat to +180 s | RSS sampled from `/proc/<pid>/status` | `ws-fanout.js` |
| **Client flushes per 1,000 messages** | 1,000.0 (`immediate`) | 2.6 (`batched`) — **PARKED, see §5** | **rAF cadence unestablished; not a display-rate result** | `seat-churn.js` |

Only the first row is a genuine before/after produced by a change to this system.
The broadcast-cost row is a before/after of *observation*, not of a code change.
Every other row is a single-point measurement and is labelled as one.

## 7. Module 7.3a findings — reported, nothing fixed

**This is the 7.3b approval gate.** Each finding names the minimum change and
stops. No index was created or dropped, no pool was resized, no code was touched.

### F-1 — Own-hold broadcast may render your own held seat as unavailable
**Gate ruling: do not fix. Reproduce first.**
**Reproduction result: NOT REPRODUCED. The proposed mechanism is DISPROVED as
stated. Status remains UNPROVEN.**

**The original hypothesis.** A seat the user selects sometimes turns
dark/unavailable immediately after selection. `realtime/hub.js` broadcasts
viewer-agnostically by design, and the client compensates at
`client/src/pages/SeatMapPage.jsx:133`:

```js
if (status === 'held' && heldRef.current.has(seat.id)) status = 'available';
```

That guard needs `heldRef` to already contain the seat. Because `routes/shows.js`
fires `void broadcastSeats(...)` before sending its 201, the claim was that the
**frame can arrive before the HTTP response**, so the guard misses.

**The reproduction.** A read-only harness (`/tmp/sr7/f1-repro.mjs`, outside the
repository, no imports beyond Node 22's built-in global `WebSocket`, no
instrumentation of any kind) opened a real socket to show 20 and, for 25
successive seats, measured when the `seats` frame for that seat arrived relative
to when that seat's hold response resolved.

| | |
|---|---|
| Trials with both observations | **25** |
| Frame reported `held` for the owner's own seat | **25 / 25** |
| **Frame arrived BEFORE the 201 resolved** | **0 / 25** |
| Frame arrived after the 201 | **25 / 25** |
| Delta (ws − http) | min **+0.13 ms** · median **+1.91 ms** · max **+7.18 ms** |
| HTTP response time | 5.2 – 26.6 ms |

**What this establishes.** The server does broadcast a user's own hold back to
them as `held` — 25 out of 25, exactly as `hub.js` documents. That ingredient is
**CONFIRMED**.

**What this disproves.** The frame never arrived first. It arrived **after** the
response in every trial, by a median of 1.91 ms. The reason is visible in the
code: `broadcastSeats` awaits `getSeatStatusFor` — a Postgres query plus a Redis
`MGET` — before it can send anything, while the 201 is written immediately. The
response reliably wins. **The mechanism as originally written is wrong.**

**What remains unresolved.** A ~2 ms margin at the network layer is not the same
as the client having *applied* the response. `fetch` resolving is not React
committing state, and `heldRef` is assigned during render. Whether React has
committed by the time the frame is processed ~2 ms later is a client-side timing
question this harness cannot see.

**And the symptom is real and still unexplained.** Dark seats among the user's
own selections were directly observed. Something produces them; the explanation
offered here is not it.

**Proving or dismissing the residual hypothesis requires instrumenting the
client** — an application-code change, outside Phase 7 scope. It was **not made,
and approval was not assumed.**

Ruled out first, read-only, at the time of observation: no loadtest process
running; Redis, Postgres and the API agreed exactly (16 keys ↔ 16 `held`, 2 rows
↔ 2 `booked`); sweep disabled with zero activity; `released_booking_seats` empty
and no booked seat ever reverted. Separately, "held seat later becomes available"
is **not** this finding — that is hold expiry at the 420 s TTL, which Phase 6 §8
already records as never broadcast.

**Recommendation:** carry to Phase 8 / `BACKLOG.md` P3 as an **open, unexplained
UI symptom** — not as a diagnosed race. The next step is client instrumentation
to capture the order of `heldRef` commit versus frame application, which needs
approval. Do not fix what has not been reproduced.

### F-2 — `pg` pool ceiling is 10, and it is the binding constraint
`server/src/db/pool.js` sets no `max`, so `pg` allows **10**. Sampled during a
200-VU hold load, `pg_stat_activity` showed **exactly 10** connections at every
sample, while Postgres itself allows `max_connections=100`.

Most sampled connections were **idle**, and §4.3 shows throughput flat at ~600/s
from 50→200 VUs with latency scaling ~4.4×. Together these say the queue is in
Node, and that Postgres was not the bottleneck for this workload.

Reported by Phases 2, 5, 6 and now 7; changed by none.
**Minimum change if approved:** set `max` in `pool.js`. Architecture — gated.

### F-3 — Two indexes over identical columns on `booking_seats`
Both survive on the live schema:

- `booking_seats_show_id_seat_id_idx` — non-unique, Phase 1.2
- `booking_seats_show_id_seat_id_key` — **unique**, Phase 2.4's guarantee

`pg_stat_user_indexes` shows the planner using the **non-unique** one for the
whole-show availability path (4,627 scans) and the unique one for the scoped
broadcast path (8). Both are maintained on every insert.

Migration `002` already recorded this as deliberate and deferred.
**Minimum change if approved:** migration `005` dropping the non-unique index.
Schema — gated. **The unique constraint is a protected Phase 2 artefact
(`CLAUDE.md` §10) and must not be touched.**

### F-4 — The broadcast is expensive, and skipping it when unwatched is load-bearing
Identical hold workload, watchers varied:

| Watchers | holds/sec | vs 0 | hold latency avg |
|---|---|---|---|
| 0 | **499.5** | — | 54.6 ms |
| 1 | **373.4** | **−25.2%** | 75.8 ms |
| 50 | **237.8** | **−52.4%** | 117.4 ms |

**One watcher costs a quarter of hold throughput.** That is the scoped query plus
the Redis `MGET`, paid once per seat change regardless of room size. The further
drop to 50 watchers is per-socket fan-out.

This prices the cost Phase 6 §11 flagged as unmeasured. `hub.js`'s early return
when a room is empty is doing substantial work.
**No change recommended without a decision about what to trade.** Gated.

### F-5 — No WebSocket memory growth observed
RSS sampled from `/proc/<pid>/status` at 100, 500 and 1,000 sockets, through
connect, sustained churn, disconnect and +180 s. RSS moved between ~89 MB and
~152 MB with GC and **settled at ~96 MB, flat from +10 s through +180 s** after
1,000 sockets disconnected. **No monotonic growth across the three levels.**

**Per-socket cost was not isolable** — GC noise exceeds it at this scale, so no
per-socket figure is given. A definitive retention answer would need `--expose-gc`
or heap snapshots, which is a runtime-flag change and out of scope.

> **A discarded measurement, disclosed.** The first attempt sampled the wrapper
> shell rather than the node process and reported a flat, entirely plausible
> **2,216 KiB** across every load level. It was caught by noticing the number
> never moved, the harness was fixed to resolve the real node PID, and the run
> was repeated. **None of those numbers appear anywhere in this document.**

### F-6 — Sequential scans in the availability query
`EXPLAIN (ANALYZE, BUFFERS)` on the whole-show query shows two:

- `Seq Scan on show_prices` — filter `show_id = N`, "Rows Removed by Filter: 53"
- `Seq Scan on bookings` inside the `EXISTS` subplan, filter `status <> 'cancelled'`

**Both are correct today.** `show_prices` holds 56 rows and `bookings` 5; a seq
scan on a table that small beats an index. Execution was 0.446 ms (160 seats) and
4.479 ms (5,000 seats). Recorded because they are the shapes that would degrade
first as `bookings` grows, not because they are wrong now.

The scoped broadcast query uses `booking_seats_show_id_seat_id_key` and executes
in **0.148 ms**. `released_booking_seats` uses its FK index.
**No index changes recommended at current data volumes.** Gated regardless.

### 7.3b gate — rulings, 2026-08-22

The gate was presented and ruled on. **No fix was applied. No application code,
schema, migration, dependency or configuration was changed.**

| | Finding | Ruling | Action taken |
|---|---|---|---|
| **F-1** | Own-hold broadcast race | **Do not fix. Reproduce first.** | Reproduced read-only: **NOT REPRODUCED**, mechanism **disproved as stated**, symptom still unexplained. Recorded above. No code change. Further proof needs client instrumentation — **approval not assumed** |
| **F-2** | `pg` pool pinned at 10 | **DEFER** | `pool.js` untouched. Recorded for a future architecture/performance phase |
| **F-3** | Duplicate `booking_seats` indexes | **DEFER** | No migration `005`. Schema untouched. Recorded for a future schema-maintenance phase |
| **F-4** | One watcher costs 25% of hold throughput | **DEFER / DOCUMENT** | Recorded as a **measured architectural trade-off, not a defect**. No implementation change |
| **F-5** | WebSocket memory | **CLOSED** | No action required. No growth observed through 1,000 sockets. **Resolved** |
| **F-6** | Seq scans on `show_prices` and `bookings` | **CLOSED for current scale** | No indexes added. Acceptable at the measured dataset size; revisit if data volume changes |

Only **F-1** stays open, and it is open as an *unexplained UI symptom*, not as a
diagnosed race. F-2, F-3, F-4 are deferred with their evidence. F-5 and F-6 are
closed.

## 8. Verification — one complete pass

Run once, after all modules. Phase 7 altered no application code, so this is
regression coverage for Phases 1–6 plus artefact integrity.
**Result: 24 PASS, 0 FAIL.**

| Phase | Check | Result |
|---|---|---|
| 1 | 4 migrations applied | **PASS** |
| 1 | `/health` → `{"status":"ok","db":"ok","redis":"ok"}` | **PASS** |
| 1 | register 201 · login returns token · `/me` 200 · `/me` unauthenticated 401 | **PASS** ×4 |
| 1 | `/api/movies` · `/movies/1/shows` · seatmap 200 · unknown show 404 | **PASS** ×4 |
| 2 | 500-VU contention, `safe` | **PASS** — 0 double-bookings, 3/3 (§4.1) |
| 4 | acquire hold 201 · TTL reported (420 s) · release 200 · Redis empty after | **PASS** ×4 |
| 4 | second user refused a held seat — 409 `SEATS_HELD` | **PASS** |
| 4 | owner sees own hold `available`, anonymous sees `held` | **PASS** ×2 |
| 5 | 10,000-attempt concurrent replay | **PASS** — exactly 1 booking (§4.2) |
| 6 | sweep cancels a stale pending booking | **PASS** — `scanned 1, cancelled 1, seats released 1` |
| 6 | seats archived to `released_booking_seats` | **PASS** |
| 6 | swept seat reads `available` again | **PASS** |
| 7 | three new scripts present | **PASS** ×3 |
| 7 | no bearer token in any Phase 7 result JSON | **PASS** |
| 3 | seat grid, selection, max-6, running total | **NOT RUN as a scripted check** — see below |
| 6 | rAF flush ratio | **PARKED** — §5 |

**Phase 3 and the browser.** Not scripted, because this phase has no browser
harness. It was, however, **exercised end-to-end by hand** during the Module 6.4
attempts: the seat map rendered, selection took real Redis holds, and a booking
was created *and paid* through the UI (`SR-5T18CAYNCW`, 2 seats, status `paid`).
That is direct evidence the Phase 3→4→5 path works in a browser, but it was
**observed, not asserted by a test**, and is labelled accordingly.

**Sweep test method:** a pending booking was created through the API, then aged
with `update bookings set created_at = now() - interval '30 minutes'`.
`PENDING_BOOKING_TTL_SECONDS` could not be lowered instead, because
`reconcileService` asserts it must exceed the 420 s hold TTL. The row was test
data and the database was re-seeded immediately afterwards.

## 9. Deviations from the approved plan

- **D-1 (naive baseline database).** The plan said create `showrush_baseline`.
  It already existed from Phase 2 at exactly the right schema but carrying 315
  stale `booking_seats` rows. On instruction it was **re-seeded in place** rather
  than dropped and recreated — the seed truncates, so the effect on data is
  identical and no `DROP DATABASE` was run.
- **`ws-fanout.js` used `k6/websockets`.** The plan flagged the module path as
  unverified. Probed against the installed binary: `k6/net/websockets` **does not
  exist** in v2.2.0, `k6/experimental/websockets` is deprecated, `k6/ws` is the
  legacy API. `k6/websockets` was verified callable and used. **The Node + `ws`
  fallback was not needed; no dependency was added.**
- **Two discarded measurements**, both disclosed in place rather than silently
  dropped: the fourth naive run (§4.1) and the first WebSocket memory run (F-5).
- **Module 6.4 not completed** — §5.
- **Harness lives in `/tmp/sr7`**, outside the repository: `lib.sh`, `verify.sh`,
  `ws-memory.sh`, `broadcast-cost.sh`, `explain.sql`. Named here because it is a
  temporary artefact; delete at will.

## 10. Known limitations

- **The rAF number is still owed.** Repeated from §5 because it is the sentence
  most likely to be dropped when the batching numbers are quoted.
- **All numbers are from one 4-core laptop** running Postgres, Redis, Node and
  the load generator simultaneously. The *ratios* are the meaningful part;
  absolute figures would differ on real hardware.
- **~600 holds/sec is this configuration's ceiling**, not the system's. It is
  bound by a 10-connection pool, a single Node process and this machine.
- **Availability latency covers the anonymous path only.** The `optionalAuth`
  viewer-specific merge was not measured.
- **Broadcast cost was measured at 0, 1 and 50 watchers on one show.** Nothing is
  claimed about many rooms, many shows, or many instances.
- **WebSocket memory: no growth observed, not "no leak proven."** Absence of
  growth over 180 s at 1,000 sockets is not a guarantee.
- **Hold throughput is uncontended by construction.** It says nothing about
  throughput under contention, which is `seat-contention.js`'s question.
- **Single instance.** Unchanged from `BACKLOG.md`.
- **`.env` still contains `NEON_DATABASE_URL`** — the credential Phase 6 §9
  flagged for rotation. No code reads it and `.env.example` does not list it. It
  was **not printed** during this phase. **Still un-rotated.**

## 11. Final environment state

**Local Postgres** (`localhost:5433/showrush`, Docker 17.11) — restored with
`npm run seed`, which truncates and cascades:

| | |
|---|---|
| users / movies / screens / seats / shows | 1 / 5 / 3 / 504 / 20 |
| bookings / booking_seats | 5 / 11 (the seeded demo state) |
| `payment_events` / `released_booking_seats` | 0 / 0 |
| duplicate `(show_id, seat_id)` rows | **0** |
| migrations | `001` + `002` + `003` + `004` — **unchanged; Phase 7 added none** |

The 5,000-seat stress screen is **absent** — `npm run seed` truncates it, and it
is re-created on demand with `npm run seed:stress`.

**Local Redis** (`localhost:6380`): **0 keys**, flushed.

**`showrush_baseline`**: left in place, holding the last naive run's data. It is
disposable; drop it when convenient. **`showrush_25` and `showrush_repro`**: Phase 2
leftovers, **not touched**.

**`.env`**: unmodified. Every run's configuration was passed as environment
variables on the command line. **`.env.example`: unmodified** — Phase 7 introduced
no new variables.

**Neon: untouched.** No connection made, no query run.
**Render: untouched.** No service, env var or deploy changed. Nothing deployed.

## 12. Git state and commit boundary

Branch `feat/benchmarks`, cut from `feat/reconciliation` @ `7902b8a`.
**Nothing committed, pushed, merged, rebased or deployed.**

```
 M README.md                                      7.4 table, Benchmarks section only
 M loadtest/README.md                             the three new scripts
?? docs/phases/phase-7-benchmarks.md              this file
?? loadtest/hold-throughput.js                    7.1a
?? loadtest/availability-latency.js               7.1b
?? loadtest/ws-fanout.js                          7.1c
?? loadtest/results/7.2b-naive-2026-08-22-{1,2,3}.json
?? loadtest/results/7.2b-safe-2026-08-22-{1,2,3}.json
?? loadtest/results/7.2c-replay-2026-08-22.json
?? loadtest/results/7.2d-holds-2026-08-22-vus{50,200}.json
?? loadtest/results/7.2e-availability-2026-08-22-{normal,stress}-{cold,held}.json
?? loadtest/results/7.3a-broadcast-2026-08-22-watchers{0,1,50}.json
?? loadtest/results/7.3a-ws-fanout-2026-08-22-{100,500,1000}.json
?? loadtest/results/6.4-{immediate,batched}-visible-2026-08-22.json
```

**No dependency was added, removed or reinstalled.** `package.json`,
`package-lock.json`, `server/package.json` and `client/package.json` are
untouched, as are all migrations, every file under `server/src` and
`client/src`, `PLAN.md`, `CLAUDE.md`, `BACKLOG.md`, `render.yaml`,
`docker-compose.yml`, both `.env.example` files, and `docs/phases/phase-0…6`.
`main` is untouched at `692ffcf`; Phases 3–7 remain unmerged.

`README.md` was modified **only** inside `## Benchmarks`. Its stale "Known
limitations" list — which still says holds and payment do not exist — was
deliberately left alone; Phase 6 §8 flagged it for Phase 8.1 and it is not
Phase 7's.

## 13. Handoff to Phase 8

- **The §6 results table is 8.1's benchmark section**, ready to lift.
- **F-1 through F-6 are 8.2's raw material** — particularly F-2 and F-4, which
  turn "why a unique constraint rather than locking" and "what does the live
  update cost" into questions with measured answers.
- **Whatever is deferred at the 7.3b gate becomes an 8.3 `BACKLOG.md` entry**,
  carrying its evidence rather than a suspicion.
- **The rAF measurement is still owed** (§5). It needs a browser environment that
  can be shown to sustain display-rate `requestAnimationFrame` under a
  ~238 msg/s arrival rate. Everything else for it is in place and re-runnable.
- **F-1 was reproduced and did not confirm.** The proposed mechanism is
  disproved; the dark-seat symptom is real and remains unexplained. It carries
  forward as an open UI symptom, and the next step — client instrumentation —
  needs approval before any code is touched.
- **`README.md`'s "Known limitations" list is stale for Phases 4, 5 and 6** and is
  8.1's to correct.
- **`NEON_DATABASE_URL` in `.env` should be rotated.**
