# Phase 6 — Reconciliation + live updates

**Status:** IMPLEMENTED and VERIFIED. Uncommitted at time of writing.
**Branch:** `feat/reconciliation`, cut from `feat/payments` @ `00ca1f7` — **not** from `main`.
**Source of truth:** approved Phase 6 plan (this session), `PLAN.md` §Phase 6, `CLAUDE.md` §10
**Rules:** `CLAUDE.md` — not restated here
**Written:** 2026-08-22

> This document records what was built and what was measured. It does not
> restate the plan, and it does not revise Phase 1–5 documentation. Where a
> check could not be run, it says so rather than implying coverage.

---

## Context

Phase 5 closed with three things open, and Phase 6 owns all three.

1. **Nothing expired an unpaid booking.** `docs/phases/phase-5-payments.md` §8
   recorded it plainly: a `pending` booking's seats stayed claimed forever.
2. **`cancelled` and `refund_pending` had never been written.** Both have been
   legal values of `bookings.status` since Phase 1.2 defined the `CHECK`.
3. **A viewer only learned a seat had changed by reloading.**

`PLAN.md` calls this phase overloaded by design and fixes the slip order:
reconciliation wins, live updates get cut. Nothing was cut — but the module
order was reversed for that reason, and 6.2 was built before 6.1.

### The repository fact that shaped the phase

`booking_seats_show_id_seat_id_key` (migration 002, Phase 2.4) is an
**unconditional** `UNIQUE (show_id, seat_id)`, while `availabilityService`
treats a `cancelled` booking's seats as free (`b.status <> 'cancelled'`).

So the obvious implementation of "expire a booking" — set the status and stop —
produces a seat that **reads `available` on the map and still raises 23505 on
re-booking**. That is worse than the state the sweep exists to fix, and it is
invisible until someone tries to book.

Migration 002 is a protected artefact. It was not altered, not made partial, and
not replaced. Instead the sweep archives the `booking_seats` rows into a new
table and deletes them, which releases the constraint entry and preserves the
seat list Module 6.1 needs. This was ruled on before implementation began.

---

## 1. What exists at the end of Phase 6

A reconciliation sweep that expires unpaid bookings and genuinely gives their
seats back, runnable on an interval or from the command line and safe to overlap
itself; a payment path that resolves a late payment in both directions —
honoured if the seats are still free, `refund_pending` if they are not; a
WebSocket room per show carrying seat-status changes from five call sites; a
client that batches those updates and recovers missed ones by refetching on
reconnect; and optimistic seat selection that rolls back on refusal and cannot
be corrupted by an out-of-order response.

Two browser tabs stay in sync, a late payment resolves correctly in both
directions, and 6.4 has a measured before/after — with one stated limit on what
that measurement covers (§6).

---

## 2. Module summaries

Built in the order **6.0 → 6.2 → 6.1 → 6.3 → 6.4 → 6.5**. `PLAN.md` lists 6.1
before 6.2; the order was reversed on approval because 6.1's "seat was taken"
branch cannot exist, or be exercised, until something can cancel a booking.
`PLAN.md`'s numbering is unchanged.

### 6.0 — Migration 004 (`server/migrations/004_released_booking_seats.sql`)

One row per seat the sweep released, with the booking it belonged to and a
`reason` restricted by `CHECK` to `'expired'`. Deliberately **not** unique on
`(show_id, seat_id)`: the same seat is released many times over its life, by
different bookings, and uniqueness here would be a claim about seat identity —
which belongs to the `seats` table alone.

It is an audit record and the seat list 6.1 re-claims from. It is **never** an
availability source: `availabilityService` does not read it and must not learn
to.

### 6.2 — The sweep (`reconcileService.js`, `reconcile.js`)

Candidates are nominated by an unlocked `SELECT` on `status = 'pending'` past
`PENDING_BOOKING_TTL_SECONDS`, bounded by a batch limit. Each booking is then
expired in its own transaction: `SELECT … FOR UPDATE SKIP LOCKED` re-checking
`status = 'pending'`, `INSERT … SELECT` into the archive with `RETURNING`,
`DELETE` from `booking_seats`, `UPDATE` to `cancelled`, commit.

`SKIP LOCKED` is what makes two overlapping sweeps safe — the second leaves a
row the first is already handling rather than blocking on it. The repeated
`status = 'pending'` predicate is what makes the sweep safe against a payment,
because `paymentService` takes `FOR UPDATE` on the same row.

Scheduled by `setInterval` in `index.js` behind a single in-flight flag, and
available as `npm run reconcile`. Both call the same `runSweep()`; there is no
second implementation. `RECONCILE_INTERVAL_SECONDS=0` disables the interval and
leaves the CLI working, which is how a Phase 2 or Phase 5 benchmark guarantees
nothing mutated bookings underneath it.

**The Redis half of `PLAN.md` 6.2 is a deliberate no-op**, and that is a
decision rather than an omission. A hold is one key with an `EX` and nothing
else; Redis expires it without help. A sweep would have to `SCAN` the keyspace,
which is exactly the second seat-status path `CLAUDE.md` §10 forbids. An orphan
hold on an already-sold seat is harmless and gone within 420 s.

### 6.1 — Late payment (`paymentService.js`)

`recordPayment` opens with `SELECT … FOR UPDATE` on the booking, so the sweep
cannot cancel it halfway through paying. The event `INSERT` remains the
idempotency check — untouched. Then:

- `pending` → `paid`, exactly as Phase 5 did;
- `cancelled` → re-claim the archived seats inside a **savepoint**. Success →
  `paid`. `23505` on the Phase 2.4 constraint → roll back to the savepoint →
  `refund_pending`;
- `paid` / `refund_pending` → 409 `BOOKING_NOT_PENDING`, unchanged.

Whether the seats are free is never *asked*. It is answered by trying to take
them and letting the constraint decide — the same argument Phase 2 and Phase 5
both make, and the reason no second availability path appears here.

The savepoint is load-bearing: a `23505` aborts the whole transaction unless
rolled back to one, and this transaction still has to record the event and write
`refund_pending`. The event is recorded `succeeded` in both directions — money
was taken; whether the seat could be honoured is the booking's status, not the
event's.

### 6.3 — WebSocket broadcast (`realtime/hub.js`, `availabilityService.js`, four callers + the sweep)

`ws` attached to the existing HTTP server at `/ws?show_id=<id>`. One room per
show, server→client only: no join message, no subscribe protocol, inbound frames
ignored, `maxPayload` 1 KiB, show fixed at upgrade. Unknown show refused at
upgrade; `Origin` must match `CLIENT_ORIGIN` when one is set — CORS does not
apply to WebSocket upgrades, so this is the only same-origin check there is. An
absent `Origin` is allowed, on the same reasoning `middleware/auth.js` uses to
exempt bearer tokens from the CSRF header: a request a browser cannot forge
carries its own proof of intent.

Rooms are public to anyone with the show id, matching the already-public seat
map. Nothing viewer-specific travels on the socket.

`availabilityService` gained exactly one export, `getSeatStatusFor`, built from
the **same SQL template** as `getSeatStatus` with one added predicate. The
broadcast calls it with no `forUserId`, so the answer is viewer-agnostic and a
hold reads `held` to everyone including its owner; the client ignores an
incoming `held` for a seat it holds itself. Status is never inferred at the call
site — "a hold was released, so the seat is available" is wrong the moment the
seat is also booked.

Five call sites, each after its state change is durable: hold acquired, hold
released, booking commit, payment commit, and the sweep's per-booking commit.
Every one is fired without awaiting and cannot fail its caller. The read is
skipped entirely when nobody is watching, so an unobserved show costs one `Map`
lookup rather than a query per hold.

### 6.4 — Batching (`useSeatEvents.js`, `loadtest/seat-churn.js`)

Messages land in a `Map` keyed by seat id — fifty changes to one seat in one
frame collapse to one entry — and flush in a single `setState`. `SeatMapPage`
returns the same object when nothing actually changed, so a flush of no-ops
costs no render.

Both paths ship permanently behind `VITE_SEAT_UPDATE_MODE`, defaulting to
`batched`. The same discipline that keeps `BOOKING_MODE=naive` alive: without
the un-batched path the before-number could never be re-measured, and an
unreproducible number is a claim.

A hidden tab does not run `requestAnimationFrame`, so a buffered update would
sit there while the buffer grew. A 1 s timeout is the fallback clock for that
case. **That fallback is what §6's measurement actually exercised** — see there.

### 6.5 — Optimistic selection (`useSeatSelection.js`, `SeatMapPage.jsx`, `SeatButton.jsx`, `SeatMap.jsx`, `seatmap.css`)

A `pending` set in the hook, rendered as `data-pending` and an `aria-label` of
"selecting". Selection stays derived — no effect, no flash.

The out-of-order guard is a **per-seat monotonic sequence number** held in a
ref. A response may only act on the seat it was issued for, and only if no newer
click has happened since. Click, unclick, click faster than the network and
three responses come back for one seat; without this the first one's rollback
undoes the third one's selection.

The hook keeps its Phase 3 contract: no JSX, no DOM, no `window`, no fetch.

---

## 3. The contract, as built

**One behaviour change, no shape change.** `POST /api/payments/confirm`:

| Case | Phase 5 | Phase 6 |
|---|---|---|
| booking `pending` | 201 `paid` | unchanged |
| booking `cancelled`, seats free | 409 `BOOKING_NOT_PENDING` | **201, `booking.status: "paid"`** |
| booking `cancelled`, seats taken | 409 `BOOKING_NOT_PENDING` | **201, `booking.status: "refund_pending"`** |
| booking `paid` / `refund_pending` | 409 `BOOKING_NOT_PENDING` | unchanged |
| replay of any of the above | 200 `duplicate: true` | unchanged |
| 402 · 403 · 404 · 401 · 400 · `EVENT_ALREADY_USED` | | all unchanged |

No new field, no new error code. `refund_pending` reaches the client through the
existing `booking.status`, which `BookingResult.jsx` already renders verbatim.

**New surface: `GET /ws?show_id=<id>`.** Server→client JSON only.

| type | payload |
|---|---|
| `hello` | `{ type, show_id, heartbeat_seconds }`, once on connect |
| `seats` | `{ type, show_id, seats: [{ id, status }], at }`, `status` ∈ `available \| held \| booked` |

Refused at upgrade: unknown path (404), unknown show (404), mismatched `Origin`
(403). Server-side ping every 30 s; sockets that miss a pong are terminated.

**Unchanged in shape:** the seat map, `POST /api/bookings`, all three hold
routes, `/health`, `/`, every auth route. No new REST endpoint.

**New environment variables** (`.env.example` updated):
`PENDING_BOOKING_TTL_SECONDS` (default 900) and `RECONCILE_INTERVAL_SECONDS`
(default 60, `0` disables the interval). Both are validated at import, so a
malformed value is a refusal to start rather than a default quietly substituted.
`PENDING_BOOKING_TTL_SECONDS` must exceed the 420 s hold TTL or the server
refuses to start — a booking must not be able to expire while its own hold is
still live.

---

## 4. Deviations from the approved plan, and their status

| # | Deviation | Status |
|---|---|---|
| **D-1** | **`client/src/seatmap/SeatMap.jsx` was modified although it was absent from the approved §7 file list.** Two lines: an `isPending` prop on the signature, and `pending={isPending ? isPending(seat.id) : false}` passed to `SeatButton`. `SeatMap` is the only thing that renders `SeatButton`, so 6.5's pending state cannot reach the DOM without it. The omission was a defect in the plan, not a discovery about the repository. The edit was made **before** it was flagged, which is the wrong order and is recorded as such. | **RATIFIED** (2026-08-21) after the full diff was reviewed. No further `SeatMap` changes. |
| **D-2** | **A fifth broadcast call site was added**, in `reconcileService.js` after each per-booking commit. The approved §6.3 enumerated four and did not include the sweep — so a seat freed by the sweep reached nobody until a reload. Proposed with its exact diff and **not** written until approved. | **APPROVED** (2026-08-21). Existing message shape, existing mechanism, no new type or state. `runSweep`'s return value already carried `{ bookingId, showId, seatIds }`, which is why the wiring needed no restructuring. |
| **D-3** | **6.4's rAF path was not measured.** The browser harness kept the tab `hidden` throughout, and Chrome does not run `requestAnimationFrame` in a hidden tab. The recorded numbers are therefore the **1 s fallback-clock** measurement. Forcing the rAF branch would have stalled the buffer and produced a fabricated figure. | **ACCEPTED** (2026-08-22). Recorded as measured, labelled for exactly what it covers. No rAF number is claimed, estimated or inferred anywhere. |
| **D-4** | **`CLIENT_ORIGIN` was absent from the local `.env`** — not just unset in this session, absent from the file. Added as one line for the browser checks, on explicit approval, and removed at cleanup. `.env.example`, `render.yaml` and Render were untouched. | **APPROVED** (2026-08-21) for local verification only. `.env` restored byte-exact afterwards. |

Everything else was built as approved: the archive-and-delete design, the `ws`
dependency, interval plus CLI, the reversed module order, the Redis-half no-op,
the 201 contract change, both env-var defaults, the public room policy, the
permanent `VITE_SEAT_UPDATE_MODE` flag, and the new `loadtest/` files.
`BACKLOG.md` was **not** touched — that remains Phase 8.3's responsibility.

---

## 5. Verification — one pass, after all six modules

Run once, after 6.5, exactly as the plan required and explicitly not per module.
Local only: `docker compose` Postgres `localhost:5433`, Redis `localhost:6380`.
Neon and Render untouched, nothing deployed.

**56 explicit pass/fail evaluations, all passed:** 43 scripted HTTP/SQL/WebSocket
assertions, 6 boot-configuration probes, and 7 browser checks — each evaluated
against a stated expectation and recorded as a row below.

Two further browser readings were captured during the same runs and are **not**
counted above: the `batched` and `immediate` counter reads behind §6's
measurement. Those are measurements, not assertions — they have no pass/fail to
record, and they are evidence for §6 rather than coverage of the matrix.

The two verification scripts and the boot probe lived in the session scratchpad,
outside the repository, and were deleted; no verification artifact was written
into the repo.

### Phase 6 acceptance matrix

| # | Check | Result |
|---|---|---|
| 1 | Migration 004 applies, then skips; 001–003 skip; Phase 2.4 constraint present and unchanged | **PASS** |
| 2 | Aged `pending` → `cancelled`, 0 `booking_seats`, seats archived | **PASS** |
| 3 | The released seat reads `available` **and** re-books with a 201 — the constraint case | **PASS** |
| 4 | Sweep idempotent: a second run cancels 0 | **PASS** |
| 5 | Two concurrent sweeps: 3 bookings, 3 archive rows, no error, no double archive | **PASS** |
| 6 | CLI and interval run the same `runSweep` | **PASS** |
| 7 | Fresh `pending` never swept; `paid` never swept even aged 120 minutes | **PASS** |
| 8 | Late payment, seats free → 201, `paid`, seats re-claimed | **PASS** |
| 9 | Late payment, seats taken → 201, `refund_pending`, no seat row, event `succeeded`, 0 double-sells | **PASS** |
| 10 | Replay of both 6.1 outcomes → 200 `duplicate:true`, one `payment_events` row each | **PASS** |
| 11 | Sweep vs payment fired together → one consistent state, invariant holds | **PASS** |
| 12 | Two browser tabs reflect hold · release · book | **PASS** (latency not measured — see §8) |
| 13 | Other show silent · unknown show refused · mismatched `Origin` refused · configured `Origin` accepted | **PASS** |
| 14 | Socket down → reconnect → refetch recovers a change that was never broadcast | **PASS** |
| 15 | Redis down → holds 503, `/health` degraded, **broadcasts still flow**; reconnects after restart | **PASS** |
| 16 | 6.4 before/after measured | **PASS, with D-3's limit** |
| 17 | Optimistic rollback, pending state, out-of-order safety | **PASS** |
| 18 | Boots with `RECONCILE_INTERVAL_SECONDS=0` and with `BOOKING_MODE=naive` | **PASS** |
| — | **D-2's fifth site:** the in-process sweep cancels **and** broadcasts | **PASS** |

Row 14 is the strongest single result. A booking for seat 5 was inserted with
**raw SQL while the server was down**, so no broadcast for it could ever have
existed. After the restart the tab showed it `booked` while the hook's `messages`
counter stayed at 3 — proving the update came from the reconnect refetch and not
from a message.

Three guard probes beyond the matrix: `PENDING_BOOKING_TTL_SECONDS=100` refuses
(below the hold TTL), `RECONCILE_INTERVAL_SECONDS=sixty` refuses, `-5` refuses.
`BOOKING_MODE=naive` with `NODE_ENV=production` still refuses, unchanged.

### Database invariants after the run (`loadtest/count-reconciliation.sql`)

```
cancelled 15 · paid 9 · refund_pending 1
released_booking_seats: 17 seats across 17 bookings, reason 'expired'
cancelled bookings still holding seats  → 0 rows
seats sold more than once               → 0 rows
```

The first of those two zero-row results is the whole point of Module 6.2; the
second is Phase 2's guarantee, restated and still true.

### Phase 1–5 regressions

| Phase | Check | Result |
|---|---|---|
| 1 | register · login · `GET /api/movies` · seat-map payload shape | **PASS** |
| 1 | max-6 seats enforced server-side | **PASS** |
| 2 | `BOOKING_MODE=safe` → 201 `pending`; already-booked seat → 409 `SEATS_UNAVAILABLE` | **PASS** |
| 2 | server boots with `BOOKING_MODE=naive` and logs it | **PASS** — boot only; **no naive load was run** |
| 2 | Phase 2 scripts, SQL and result JSONs unmodified | **PASS** — verified file by file |
| 2 | `booking_seats_show_id_seat_id_key` present; **0 double-bookings** in the final database | **PASS** |
| 3 | seat map renders — 160 seats, tiers, aisle gaps, legend with prices | **PASS** (browser) |
| 3 | selection and running total | **PASS** (browser) |
| 3 | `npm run seed:stress` still produces the 5,000-seat screen | **PASS** |
| 4 | hold → 201 with 420 s TTL · `GET …/ttl` · release | **PASS** |
| 4 | two parties cannot hold one seat (409 `SEATS_HELD`; second viewer sees `held`) | **PASS** |
| 4 | the holder still sees their own hold as `available` | **PASS** |
| 4 | a `paid` booking's seat reads `booked` | **PASS** |
| 4 | server reconnects to Redis after the container restarts | **PASS** |
| 5 | happy path 201 `paid`; sequential replay 200 `duplicate:true`, one row | **PASS** |
| 5 | a second distinct event on a paid booking → 409 `BOOKING_NOT_PENDING` | **PASS** |
| 5 | 402 failure, booking still `pending`, event recorded `failed`, **hold intact** | **PASS** |
| 5 | replay of a failure → 402, provider not re-run | **PASS** |
| 5 | 403 foreign · 404 unknown ref · 401 no session · 400 bad body | **PASS** |
| 5 | **concurrent 10,000-replay** | **NOT RUN** — Phase 5's recorded measurement stands; this phase did not touch the idempotency guarantee |

Phase 2's benchmarks were not re-run either. Neither was re-measured, and
neither is re-claimed here.

---

## 6. The measurement

**Claim:** buffering incoming seat updates and applying them in one flush
reduces state applications and DOM writes by orders of magnitude under a
sustained broadcast stream.

**This is not a `requestAnimationFrame` measurement.** See D-3. The browser tab
driven by the harness reported `visibilityState: "hidden"` for the entire run and
could not be made visible; Chrome does not run `requestAnimationFrame` in a
hidden tab, so the flush clock exercised here was the **1 s hidden-tab
fallback**, not rAF. The numbers below must not be described as rAF numbers, and
no rAF figure is estimated or inferred anywhere in this repository.

| | |
|---|---|
| Script | `loadtest/seat-churn.js` (committed) |
| Raw summaries | `loadtest/results/6.4-batched-2026-08-22.json`, `…-immediate-2026-08-22.json` (bearer token redacted) |
| Date | 2026-08-22 |
| Command | `SHOW_ID=20 VUS=15 SEATS_PER_VU=2 STEP_MS=50 DURATION=20s SUMMARY_OUT=… k6 run loadtest/seat-churn.js` |
| Client build | `PROFILE=1 npm run build:client`, served by `npm run preview:client` on `http://localhost:4173` |
| Before/after switch | `VITE_SEAT_UPDATE_MODE=immediate` vs default `batched` |
| Machine | VIVEK-LAPTOP-3VEE2JPV, WSL2 (kernel 6.18.33.2-microsoft-standard-WSL2), 4 cores |
| Versions | Node v22.23.2 · k6 v2.2.0 · Postgres 17.11 (Docker, 5433) · Redis 7.4.10 (Docker, 6380) · `ws` 8.21.3 |
| Server | `BOOKING_MODE=safe`, `NODE_ENV=development`, single instance, `pg` pool default (`max` unset → 10) |
| Commit | working tree on `feat/reconciliation`, parent `00ca1f7` — **uncommitted at measurement time** |
| Tab state | **`hidden` throughout, in both runs** |

**Workload:** 15 VUs each cycling 2 seats, hold → 50 ms → release → 50 ms, for
20 s, against show 20 (84 seats). One browser tab watching that show. Every hold
and every release is one broadcast.

**Result**

| | `immediate` | `batched` |
|---|---|---|
| messages received | 4,802 | 4,624 |
| seat updates carried | 9,604 | 9,248 |
| **state flushes** | **4,802** | **11** |
| DOM mutation callbacks | 4,226 | 11 |
| DOM `data-status` attribute writes | 9,604 | 176 |

The two runs produced slightly different loads (2,401 vs 2,312 k6 iterations),
so the honest comparison is per message: **1,000 flushes per 1,000 messages
un-batched, versus 2.4 per 1,000 batched.** Attribute writes fell from 9,604 to
176 — a 55× reduction — because coalescing by seat id collapses repeated changes
to the same seat.

**How the browser-side numbers were obtained.** `useSeatEvents` keeps counters on
`window.__srSeatUpdates` (`messages`, `seatUpdates`, `flushes`) — dev-only, read
from the console, rendered nowhere and branched on by nothing. DOM writes were
counted with a `MutationObserver` on `.seatmap__rows` filtered to `data-status`,
installed from the console before each run. React DevTools re-render counts were
**not** collected: the profiling build was served, but the extension cannot be
driven from this harness.

**What these numbers are not.** They are one machine, one browser, one hidden
tab, one workload. They are not a server benchmark, not throughput, not
capacity, and — again — not a measurement of `requestAnimationFrame`.

---

## 7. Redis-down behaviour, measured

With `showrush-redis` stopped: `/health` reported `degraded` (503, `redis:
error`), a hold attempt returned **503 `HOLDS_UNAVAILABLE`** (failing closed, as
Phase 4 designed), and a **booking still succeeded and still broadcast** —
observed on a connected socket, seat status `booked`. After the container was
restarted `/health` returned to `ok` without restarting the server.

Live updates therefore do not depend on Redis. Seat *holds* do, which is the
pre-existing hard dependency `BACKLOG.md` already records.

---

## 8. Known limitations, stated rather than glossed

- **The rAF path is unmeasured.** Repeated from §6 because it is the sentence
  most likely to be dropped when the numbers are quoted.
- **Hold expiry is not broadcast.** Redis TTL fires no callback, and keyspace
  notifications are a Redis configuration change that Upstash does not
  guarantee. Another viewer sees an expired hold's seat free on their next
  reload or next unrelated broadcast for that show — up to 420 s stale.
- **In a permanently hidden tab the Phase 4 countdown throttles and never
  re-syncs**, because its recovery is `visibilitychange` and that never fires.
  A tab in that state can keep showing seats as selected after their holds have
  expired. Observed during verification and initially mistaken for an
  out-of-order bug; disproved by reading a hold key's TTL. This is Phase 4
  behaviour amplified by a never-visible tab, not a Phase 6 regression, and it
  is recorded here rather than in Phase 4's document.
- **Two-tab propagation latency was not measured.** Both tabs were correct after
  a ~1 s settle; "within a second" is an observation of that window, not a
  timing result.
- **Single instance only.** A second Node process would broadcast to its own
  sockets and nobody else's. Redis pub/sub fan-out is `BACKLOG.md` P2.
- **`refund_pending` is a marker. No refund is executed.** `BACKLOG.md` already
  records "No refunds"; Phase 6 is what finally writes the status.
- **WebSocket rooms are unauthenticated by decision**, matching the public seat
  map. Nothing viewer-specific travels on the socket.
- **WebSocket memory growth under sustained load was not measured** — that is
  Phase 7.3a, and it is reported there rather than guessed here.
- **The `pg` pool is still at its default of 10.** Reported by Phase 5, reported
  again, changed by neither. Pool sizing is Phase 7.3b and approval-gated.
- **`npm run reconcile` broadcasts to nobody** — that process has no socket
  server. Harmless by construction, and verified as silent.
- **Phase 4's two open items are unchanged**: the `GET …/ttl` two-round-trip
  race, and whether `POST /holds` should refuse an already-booked seat.
- **`README.md`'s "Known limitations" list is stale** for Phases 4 and 5 — it
  still says holds and payment do not exist. Out of this phase's approved scope
  and deliberately not corrected here; flagged for Phase 8.1.

---

## 9. Final environment state

**Local Postgres** (`localhost:5433/showrush`, Docker, 17.11)

| | After verification, restored |
|---|---|
| users / movies / screens / seats / shows / bookings / booking_seats | **1 / 5 / 3 / 504 / 20 / 5 / 11** |
| `payment_events` | **0 rows** |
| `released_booking_seats` | **0 rows** |
| duplicate `(show_id, seat_id)` rows | **0** |
| migrations | **`001` + `002` + `003` + `004`** |

Restored with `npm run seed`, which truncates and cascades. Every verification
account, booking, payment event and archive row is gone, and the stress screen
with them. The only lasting change is migration 004, which was the authorized
purpose.

**Local Redis** (`localhost:6380`, Docker): **0 keys**, flushed. The container
was stopped twice on purpose — once for §7 and once to stage 6.5's rollback —
and restarted both times. `collab-postgres` and `collab-redis` belong to a
different project and were not touched.

**`.env`** — restored byte-exact; the one `CLIENT_ORIGIN` line added for the
browser checks was removed, and the key is absent again as it was before.
**`.env.example`** gained the two new variables and is the source of truth for
them.

**Neon: untouched.** No connection made, no query run.
**Render: untouched.** No service, env var or deploy changed. Nothing deployed.

> **Security note.** During verification a `NEON_DATABASE_URL` present in the
> local `.env` — a variable no code reads and `.env.example` does not list — was
> printed in full to the session transcript, including its password. Nothing was
> transmitted anywhere and `.env` is gitignored, but **that credential should be
> rotated before any production use.**

---

## 10. Git state and commit boundary

Branch `feat/reconciliation`, cut from `feat/payments` @ `00ca1f7`. **Nothing has
been committed, pushed, merged or deployed.**

```
 M .env.example                                  6.2
 M client/.env.example                           6.4
 M client/src/api/client.js                      6.3
 M client/src/pages/SeatMapPage.jsx              6.3 · 6.4 · 6.5
 M client/src/seatmap/SeatButton.jsx             6.5
 M client/src/seatmap/SeatMap.jsx                6.5 (D-1)
 M client/src/seatmap/seatmap.css                6.5
 M client/src/seatmap/useSeatSelection.js        6.5
 M package-lock.json                             ws only
 M package.json                                  reconcile script
 M server/package.json                           ws + reconcile script
 M server/src/config/env.js                      6.2
 M server/src/index.js                           6.2 · 6.3
 M server/src/routes/shows.js                    6.3
 M server/src/services/availabilityService.js    6.3
 M server/src/services/bookingService.js         6.3
 M server/src/services/paymentService.js         6.1 · 6.3
?? client/src/seatmap/useSeatEvents.js           6.3 · 6.4
?? loadtest/count-reconciliation.sql             6.2
?? loadtest/results/6.4-batched-2026-08-22.json  6.4
?? loadtest/results/6.4-immediate-2026-08-22.json 6.4
?? loadtest/seat-churn.js                        6.4
?? server/migrations/004_released_booking_seats.sql 6.0
?? server/src/realtime/hub.js                    6.3
?? server/src/reconcile.js                       6.2
?? server/src/services/reconcileService.js       6.2
```

**One dependency was added: `ws` 8.21.3**, with zero transitive dependencies —
the lockfile diff is 23 insertions and 1 deletion. Nothing else was added,
removed or reinstalled.

Verified untouched, file by file: `README.md` and `loadtest/README.md` until
close-out, `BACKLOG.md` entirely, `PLAN.md`, `CLAUDE.md`, `render.yaml`,
`docker-compose.yml`, migrations `001`–`003`, `holdService.js`, every Phase 2 and
Phase 5 loadtest script, SQL and result JSON, and `docs/phases/phase-0…5`.
`main` is untouched at `692ffcf`; Phases 3, 4 and 5 remain unmerged.

---

## 11. Handoff to Phase 7

- **A fourth committed load script**, `seat-churn.js`, which 7.1 can adopt for
  hold throughput. It is a *generator*, not a benchmark: it reports what it
  caused, never a performance number.
- **WebSocket memory growth is explicitly a 7.3a measurement.** Rooms are
  cleaned on close and error and empty rooms are deleted, but nothing has been
  measured under sustained load or many rooms.
- **The `pg` pool ceiling is now reported by two phases** and changed by
  neither. 7.3b owns it, with approval.
- **The broadcast adds one scoped query plus one Redis `MGET` per seat change**,
  skipped entirely when no one is watching. That cost is unmeasured and is a
  legitimate 7.1 subject.
- **`released_booking_seats` has FK-hygiene indexing only**, matching Phase 1.2
  and Phase 5.0. Index tuning is 7.3b.
- **Run benchmarks with `RECONCILE_INTERVAL_SECONDS=0`.** A sweep mutating
  bookings mid-run would measure something other than the code under test. This
  is why the off switch exists.
- **The rAF number is still owed.** Two commands in a foreground browser
  produce it; §6 records both exactly.
- **Nothing from Phase 6 is left open.** D-1 through D-4 were ruled on and are
  recorded in §4; Phase 7 inherits them as settled decisions.
