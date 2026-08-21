# Phase 5 — Payment + idempotency

**Status:** IMPLEMENTED and VERIFIED. Uncommitted at time of writing.
**Branch:** `feat/payments`, cut from `feat/seat-holds` @ `d76fa5f` — **not** from `main`.
**Source of truth:** approved Phase 5 plan (this session), `PLAN.md` §Phase 5, `CLAUDE.md` §10
**Rules:** `CLAUDE.md` — not restated here
**Written:** 2026-08-21

> This document records what was built and what was measured. It does not
> restate the plan, and it does not revise Phase 1–4 documentation. Where a
> check could not be run, it says so rather than implying coverage.

---

## Context

Phase 2 made a seat sell exactly once. Phase 4 stopped two people spending seven
minutes on the same seat. Neither made anyone pay: `bookings.status` has read
`'pending'` since Phase 1.2 defined the column, and nothing had ever written
`'paid'`.

Phase 5 closes that, and carries the second of `PLAN.md`'s two non-negotiables —
replaying one payment event 10,000 times concurrently must produce exactly one
paid booking. The first non-negotiable, Phase 2's before/after, was not touched,
not re-run, and not re-measured.

---

## 1. What exists at the end of Phase 5

A `payment_events` table whose unique `event_id` is the idempotency guarantee; a
mock payment provider with request-scoped success/failure and delay controls that
are refused in production; one endpoint, `POST /api/payments/confirm`, that moves
a booking from `pending` to `paid` inside one transaction and releases the Redis
hold only after that transaction has committed; a committed k6 replay script with
its counting SQL and one recorded run; and a browser payment step.

Ten thousand replays of one event produced **one** `payment_events` row and
**one** paid booking — `PLAN.md`'s done-when for this phase.

---

## 2. Module summaries

### 5.0 — Migration (`server/migrations/003_payment_events.sql`)

One row per provider event. `event_id` carries a named unique constraint,
`payment_events_event_id_key`, because the service classifies `23505` by
constraint name — `bookings_booking_ref_key` raises the same code and means
something else. `event_id` is unique **globally**, not per booking: the id
identifies the event, and scoping it to a booking would let one id do its work
twice. `amount_paise` is a snapshot of `bookings.total_paise`, so a later price
change cannot rewrite what was charged. Failed charges are recorded too, which is
what lets a replayed failure be answered from the row.

### 5.1 — Mock provider (`server/src/services/paymentService.js`)

About thirty lines. Succeeds by default; `simulate.outcome` and
`simulate.delay_ms` (0–600000) arrive in the request body and are **rejected with
400 when `NODE_ENV=production`** — the same shape of guard `assertBookingConfig()`
applies to `BOOKING_MODE=naive`. The delay is spent *before* the transaction
opens, because what it simulates is a provider that called back late; sleeping
inside the transaction would simulate a slow database and hold a row lock for
eight minutes.

### 5.2 — Idempotency (same file)

The INSERT is the check. There is no "have I seen this event" SELECT guarding the
write — that would be the Phase 2.1 race with a different table name. A duplicate
raises `23505`, the transaction rolls back, and the stored row is read on a
**fresh** snapshot. That ordering is load-bearing: Postgres blocks the second
inserter on the index entry until the first transaction ends, so by the time
`23505` is raised the winner has committed and its row is visible to a new
statement. Reading inside the aborted transaction would see nothing.

A cheap pre-read was added ahead of the *provider call* — see deviation D-2. It
is not the guarantee and can be deleted without affecting correctness.

### 5.3 — Confirmation flow (`server/src/routes/payments.js`, service, `app.js`, `validate.js`)

Look up the booking by ref (404 unknown, 403 not yours) → run the provider →
one transaction inserting the event and, for a success,
`UPDATE bookings SET status='paid' WHERE id=$1 AND status='pending'` → commit →
*then* release the holds on that booking's seats, best effort, inside a
`try/catch` that swallows everything.

`AND status='pending'` is the second guard: a booking already paid by a different
event updates 0 rows, the transaction rolls back, and the answer is 409. Rolling
back is what keeps a rejected event out of `payment_events`, so the table means
what it says.

`validate.js` gained exactly two validators, `bookingRef` and `eventId`. No
validation library.

### 5.4 — Replay test (`loadtest/webhook-replay.js`, `loadtest/count-payment-replay.sql`)

`setup()` logs in, creates one booking on the first available seat, and refuses to
start unless it is `pending`. Every VU then confirms the same event against that
booking, barrier-synced. The script counts responses; the SQL counts rows.

### 5.5 — Client (`client/src/api/payments.js`, `BookingResult.jsx`, `SeatMapPage.jsx`)

A **Pay** button on the booking result. The event id is `crypto.randomUUID()`,
generated when the booking is created and held in a ref until it is dismissed, so
pressing Pay again replays the *same* event rather than starting a new one. The
status shown is always the server's own.

---

## 3. The approved contract, as built

`POST /api/payments/confirm` — `requireAuth`, booking owner only.

| | |
|---|---|
| 201 | first successful confirmation |
| 200 | replay of a succeeded event — `payment.duplicate: true`, original booking |
| 400 | `VALIDATION_ERROR` (malformed body; `simulate` in production), `INVALID_JSON` |
| 401 | `UNAUTHENTICATED` |
| 402 | `PAYMENT_FAILED` — first failure *and* every replay of it |
| 403 | `FORBIDDEN` (another account's booking), `CSRF_HEADER_REQUIRED` |
| 404 | `NOT_FOUND` (unknown `booking_ref`) |
| 409 | `BOOKING_NOT_PENDING`, `EVENT_ALREADY_USED` (see D-1) |

No existing endpoint changed shape. `POST /api/bookings` still returns
`status: "pending"`; the seat map and the three hold routes are untouched.

---

## 4. Deviations from the approved plan, and their status

| # | Deviation | Status |
|---|---|---|
| **D-1** | **`409 EVENT_ALREADY_USED` added** — not in the approved §6 error table. Reached when one `payment_event_id` is used against a *second* booking. The approved table had no entry for it, and the two in-contract options were both wrong: returning the stored answer would disclose another booking's reference and total, and reusing `BOOKING_NOT_PENDING` would name a condition that is not true. | **APPROVED** (2026-08-21). Kept precisely because returning the original successful result could disclose another booking's reference and total. `duplicate: true` is preserved for a replay of the same event against the *same* booking. |
| **D-2** | **A pre-read of `payment_events` before the provider call.** The plan's §5.2 said "no SELECT beforehand". Verification proved that without it, a replayed event **re-runs the provider** — the run-6 check measured 1515 ms of injected delay being spent a second time. Your D5 ruling requires a replay to return the stored failure *without re-running the provider*, so the read was added to honour it. | **APPROVED** (2026-08-21), explicitly **as an optimisation**. The `UNIQUE` constraint remains the database correctness guarantee; this read only prevents a second provider invocation and its delay. Delete it and the system is still correct, just wasteful. |
| **D-3** | **`webhook-replay.js` `handleSummary` reads the event id from `setup_data`.** The first recorded run printed a *different* id from the one the VUs sent: k6 runs module init once per context, so the `evt-replay-${Date.now()}` default is re-evaluated in the summary context. A recorded measurement naming an id no request carried is not a record. Fixed, and the run was repeated. | **ACCEPTED** (2026-08-21). The first measurement was discarded because the reported event id did not match the one actually sent; only the corrected run is recorded, and the discarded one is not in `loadtest/results/`. |
| **D-4** | `simulationAllowed()` is exported from `paymentService.js` and called by the route. | Cosmetic; the guard lives beside the mock it guards. No behavioural difference. |

Everything else was built as approved: one file for mock + flow (D6), two
validators in `validate.js`, the client Pay button (D7), the `loadtest/README.md`
entry (D8), failed events recorded (D5), owner-session auth with no new env var
(D2), and no dependency of any kind.

---

## 5. Verification — one pass, after all six modules

Local only. `docker compose` Postgres `localhost:5433`, Redis `localhost:6380`.
Neon and Render untouched.

| # | Check | Result |
|---|---|---|
| 1 | Migration 003 applies, then skips; named unique constraint present | **PASS** |
| 2 | Happy path: hold → book (`pending`) → confirm **201** → `paid`, hold released | **PASS** |
| 3 | Sequential replay → **200**, `duplicate:true`, one row, still one `paid` | **PASS** |
| 4 | **Concurrent replay, 10,000 attempts** → one 201, 9,999 × 200, **1 row, 1 paid booking** | **PASS** (§6) |
| 5 | Failure: **402**, booking still `pending`, event recorded `failed`, **hold intact** | **PASS** |
| 6 | Replay of a failure → **402**, and the provider is **not** re-run (6 ms vs 1515 ms) | **PASS**, after D-2 |
| 7 | Ordering: hold survives a failed payment, is gone after a committed one; **Redis down → 201, payment commits** | **PASS** |
| 8 | 403 foreign booking · 404 unknown ref · 401 no session · 403 missing CSRF header · 400 missing fields · 400 bad `simulate` · 400 `simulate` under `NODE_ENV=production` · 409 event reused across bookings | **PASS** (9 checks) |
| 9 | Second distinct event on a paid booking → **409 `BOOKING_NOT_PENDING`**, no second row | **PASS** |
| 10 | Browser: book → **Pay** → `Status: paid` | **PASS**, with the caveat in §8 |

**38 automated HTTP assertions, 38 passing.** One earlier failure — run 6 — was a
real defect against the D5 ruling, not a wrong expectation; it was fixed (D-2) and
the whole suite was re-run from a fresh seed.

### Regressions (§16 of the plan)

| Phase | Check | Result |
|---|---|---|
| 1 | register · login · `GET /api/movies` · seat map payload | **PASS** |
| 1 | max-6 seats still enforced server-side | **PASS** |
| 2 | `BOOKING_MODE=safe` → 201 `pending`; already-booked seat → 409 | **PASS** |
| 2 | server boots with `BOOKING_MODE=naive` (`booking mode: naive` logged, `/health` ok) | **PASS** — booted only; **no naive load was run** |
| 2 | Phase 2 scripts, results JSONs and docs unmodified | **PASS** — `git status` clean for those paths |
| 2 | `booking_seats_show_id_seat_id_key` present; 0 double-bookings in the final database | **PASS** |
| 3 | seat map renders; selection and running total work | **PASS** (browser) |
| 4 | hold on select · 420 s countdown · release · `GET …/ttl` | **PASS** |
| 4 | two parties cannot hold one seat (409 `SEATS_HELD`; second viewer sees `held`) | **PASS** |
| 4 | **a `paid` booking's seat reads `booked`** on the seat map | **PASS** — first time this path has been exercised with a `paid` row |
| 4 | server reconnects to Redis after the container is restarted (`/health` back to `ok`) | **PASS** |

---

## 6. The measurement

**Claim:** replaying one payment event 10,000 times concurrently produces exactly
one paid booking and exactly one `payment_events` row.

| | |
|---|---|
| Script | `loadtest/webhook-replay.js` (committed) |
| Counting SQL | `loadtest/count-payment-replay.sql` (committed) |
| Raw summary | `loadtest/results/5.4-replay-2026-08-21.json` (bearer token redacted) |
| Date | 2026-08-21 |
| Command | `SUMMARY_OUT=loadtest/results/5.4-replay-2026-08-21.json k6 run loadtest/webhook-replay.js` |
| Then | `docker exec -i showrush-postgres psql -U showrush -d showrush -f - < loadtest/count-payment-replay.sql` |
| Machine | VIVEK-LAPTOP-3VEE2JPV, WSL2 (kernel 6.18.33.2-microsoft-standard-WSL2), 4 cores, 5 GB RAM visible to WSL |
| Node | v22.23.2 · **k6** v2.2.0 · **Postgres** 17.11 (Docker, port 5433) · **Redis** 7.4.10 (Docker, port 6380) |
| Server | `BOOKING_MODE=safe`, `NODE_ENV=development`, single instance, `pg` pool at its default (`max` unset → 10) |
| Commit | working tree on `feat/payments`, parent `d76fa5f` — **uncommitted at measurement time** |
| Database | freshly seeded, Redis flushed, immediately before the run |
| Event id | `evt-replay-1787305125729` |

**Workload:** 500 VUs × 20 iterations = **10,000 attempts at a concurrency of
500**, barrier-synced on each VU's first attempt. This is *not* 10,000
simultaneous connections, and nothing here should be read as claiming that.

**Result**

```
  iterations           10000        dropped_iterations   0
  201 created          1            200 duplicate        9999
  409 conflict         0            other 4xx / 5xx / no response   0
  http_req_failed      0.00%   (expected: 200, 201)
  http_req_duration    avg 355.7ms  p95 410.5ms  max 510.9ms
```

```
 rows_for_event  bookings_touched  status      →  1  1  succeeded
 event ids written more than once               →  none
 bookings 6 · paid 6 · pending 0 · booking_seats 12 · payment_events 1
```

Six paid bookings, five of which are the seed's own `SRDEMO00x` rows; the sixth
is the one this run created and paid. Twelve `booking_seats` rows: eleven seeded,
one from the run.

**On the latency figures.** They describe this laptop, this pool size and this
concurrency, and nothing else. `pg`'s default pool of ten connections is what
500 in-flight requests queue behind, so the durations above are mostly queueing.
That is a throughput property; it has no bearing on the row counts, which are the
actual claim. Pool sizing is Phase 7.3b and approval-gated — it was reported, not
changed.

---

## 7. Redis-down behaviour, measured

With `showrush-redis` stopped, `/health` reported `degraded` and a confirmation
still returned **201** with the booking `paid`: the payment commits and the hold
release is skipped. After the container was restarted, the hold key for that
seat was still present with **394 seconds** left, and expired on its own TTL —
exactly the documented degradation, observed rather than inferred.

---

## 8. Known limitations, stated rather than glossed

- **This is a user-confirmed mock payment, not a provider webhook.** It carries
  the payer's session, not a signature. A real gateway is `BACKLOG.md` P1. The
  idempotency layer is indifferent to which of the two calls it, which is the
  point of testing it now — but "webhook replay" is a name, not a claim.
- **The browser cannot press Pay twice.** The button is removed once the booking
  reads `paid`, so a literal double-press is unreachable from the UI. Replay was
  instead proven at the API with **the browser's own event id**: 200,
  `duplicate:true`, no new row. The in-flight press is guarded by `paying`.
- **Nothing expires an unpaid `pending` booking.** Its seats stay claimed
  forever. That is `PLAN.md` 6.2's reconciliation sweep, deliberately not built
  here.
- **`releaseHolds` after payment is best effort.** A failure leaves the hold
  until its TTL, which is harmless — the seat is already sold.
- **The seed writes `paid` bookings** (`SRDEMO001`–`005`), and did so before
  anything could pay. Pre-existing Phase 1 behaviour, unchanged by this phase,
  noted because it is why the final row counts show six paid bookings.
- **Phase 4's two open items are unchanged**: the `GET …/ttl` two-round-trip
  race, and `POST /holds` accepting a seat that is already booked.
- **Concurrency was 500, not 10,000.** Said again here because it is the
  sentence most likely to be quoted out of context.

---

## 9. Final environment state

**Local Postgres** (`localhost:5433/showrush`, Docker, 17.11)

| | After verification, restored |
|---|---|
| users / movies / screens / seats / shows / bookings / booking_seats | **1 / 5 / 3 / 504 / 20 / 5 / 11** |
| `payment_events` | **0 rows** |
| duplicate `(show_id, seat_id)` rows | **0** |
| migrations | **`001` + `002` + `003`** |

Restored with `npm run seed`. Every verification account, booking and payment
event is gone. The only lasting change is migration 003, which was the authorized
purpose.

**Local Redis** (`localhost:6380`, Docker): **0 keys.** Flushed after the run.
The container was stopped once, deliberately, for the run-7 check, and restarted;
no other container was touched — `collab-postgres` and `collab-redis` belong to a
different project and were left alone.

**Neon: untouched.** No connection made, no query run.
**Render: untouched.** No service, env var, or deploy changed. Nothing deployed.

**Temporary verification files** — `phase5-http.mjs`, `phase5-prod.mjs`,
`phase5-ordering.mjs` — were held in the session scratchpad, outside the
repository, and **deleted**. No verification artifact was written into the
repository. Both test servers and the Vite dev server were stopped; the browser
tab was closed.

---

## 10. Git state and commit boundary

Branch `feat/payments`, cut from `feat/seat-holds` @ `d76fa5f`. **Nothing has been
committed, pushed, merged or deployed.**

```
 M client/src/booking/BookingResult.jsx          5.5
 M client/src/pages/SeatMapPage.jsx              5.5
 M loadtest/README.md                            5.4
 M server/src/app.js                             5.3
 M server/src/lib/validate.js                    5.3
?? client/src/api/payments.js                    5.5
?? loadtest/count-payment-replay.sql             5.4
?? loadtest/results/5.4-replay-2026-08-21.json   5.4
?? loadtest/webhook-replay.js                    5.4
?? server/migrations/003_payment_events.sql      5.0
?? server/src/routes/payments.js                 5.3
?? server/src/services/paymentService.js         5.1–5.3
```

**No dependency was added, removed, or reinstalled.** `package.json`,
`package-lock.json`, `server/package.json` and `client/package.json` are
unchanged, and so are `.env`, `.env.example`, `render.yaml`, `README.md`,
migrations `001`/`002`, every Phase 2 loadtest artifact, and
`docs/phases/phase-0…4`. `main` is untouched at `692ffcf`; Phase 3 and Phase 4
remain unmerged.

---

## 11. Handoff to Phase 6

- **`payment_events` and `simulate.delay_ms` are what 6.1 is built on.** An
  eight-minute injected delay now costs one request field. 6.1 decides what
  happens when the hold expired before the event arrived — the seat may be free
  (honour it) or taken (`refund_pending`).
- **`refund_pending` and `cancelled` are still unwritten statuses.** Phase 5
  writes only `paid`.
- **Unpaid `pending` bookings accumulate and hold their seats.** 6.2's sweep owns
  that, and it must be idempotent and safe to overlap its own previous run.
- **`availabilityService` is still the single seat-status path**, now proven with
  `paid` rows as well as `pending` ones. Live updates (6.3) must broadcast from
  it, not add a second one.
- **The ordering rule is now load-bearing in two places:** hold release happens
  after the booking (Phase 4) and after the payment commit (Phase 5). Anything
  6.x adds on this path must keep Postgres first.
- **Nothing from Phase 5 is left open.** Deviations D-1, D-2 and D-3 were ruled on
  and are recorded in §4; Phase 6 inherits them as settled decisions.
- **Open, unchanged:** deploy the client as a Render static site and verify the
  cross-site cookie; the `GET …/ttl` race; whether `POST /holds` should refuse an
  already-booked seat.
