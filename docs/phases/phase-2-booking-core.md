# Phase 2 — Booking correctness

**Status:** IMPLEMENTED and MEASURED — close-out in §22. Not merged.
**Branch:** `feat/booking-core` @ `2c028b6`, from `main` @ `12be6e7`
**Source of truth:** `PLAN.md` §Phase 2, `BACKLOG.md`, `docs/phases/phase-1-foundation.md`
**Rules:** `CLAUDE.md` — not restated here
**Plan written:** 2026-08-20
**Plan approved:** 2026-08-20 — decisions Q1–Q9 resolved in §19
**Close-out written:** 2026-08-20

> §§1–20 are the plan **as approved before implementation**, preserved as
> written. Where implementation diverged, the divergence is marked inline as
> **superseded** and explained in §22 — the plan is not rewritten to look
> correct after the fact (`CLAUDE.md` §9).

---

## Context

`PLAN.md` calls Phase 2 "the most important phase" and names its before/after
concurrency numbers as one of two non-negotiables in the whole build. Phase 1
deliberately shipped `booking_seats` **without** `UNIQUE (show_id, seat_id)` so
that a real double-booking race exists to measure. Phase 2 is the phase that
measures it, fixes it, and measures it again.

Everything Phase 2 needs is already in the repository: the schema, the migration
runner, `availabilityService` as the single seat-status query path, working
authentication, a seeded local database, and a local Docker Postgres to
benchmark against. Phase 2 adds one write path, one migration, one load-test
script, and two numbers.

The output of this phase is not a feature. It is **two defensible measurements
and a documented method for reproducing both.**

---

## 1. Objective

Add the booking write path, prove it is racy, fix it with a database constraint,
and prove the fix — with numbers produced by a committed script against a
recorded environment.

**Done when** (`PLAN.md`): two numbers that can be defended, both re-runnable
today. See §14 for the exact re-run procedure, which is **not** simply "flip one
env var" — see M1 in §16.

---

## 2. Done-when criteria

- [ ] `POST /api/bookings` exists, authenticated, returning `201 {booking}`
- [ ] `BOOKING_MODE=naive` reproduces double-bookings on a database at migration
      state `001` — count recorded, non-zero, with `dropped_iterations` and
      `http_req_failed` recorded alongside it
- [ ] `002_unique_booking_seats.sql` adds `UNIQUE (show_id, seat_id)`
- [ ] `BOOKING_MODE=safe` under the identical workload produces **0**
      double-bookings, with the load confirmed to have landed
- [ ] `loadtest/` committed: the k6 script, the counting SQL, and the raw k6
      summaries behind both numbers
- [ ] Method recorded for both runs: machine, OS, Node/Postgres/k6 versions,
      commit SHA, VU count, isolation level, pool size, date
- [ ] The naive path still exists and still works — the racy branch is not
      removed or hardened
- [ ] Every Phase 0/1 frozen contract verified unchanged (§11)

---

## 3. Scope

Five modules, strictly sequential. Each depends on all its predecessors.

`2.1 → 2.2 → 2.3 → 2.4 → 2.5`

2.3 must run **before** 2.4 exists in the database, and 2.5 must run **after**.
That ordering is the whole phase; it is not an implementation detail.

### In scope

- `POST /api/bookings` — authenticated multi-seat booking
- `BOOKING_MODE=naive|safe`, permanent, defaulting to `safe`
- A deliberately racy check-then-insert path (`naive`)
- A transactional, constraint-backed path (`safe`)
- Runtime assertion and recording of the transaction isolation level
- `002_unique_booking_seats.sql`
- `loadtest/` — k6 contention script, counting SQL, results, and a README
- Two measured numbers plus their method

### Out of scope

Anything below appearing in a diff is a stop condition.

| Excluded | Owner |
|---|---|
| Redis holds, TTL, Lua, `holdService` | Phase 4 |
| Any Redis read inside `availabilityService` | Phase 4.3 |
| `'held'` as a seat status | Phase 4.3 |
| Payment, `payment_events`, idempotency, marking bookings `paid` | Phase 5 |
| Cancellation, refunds, reconciliation | Phases 5–6 |
| WebSockets | Phase 6 |
| React, Vite, `client/`, CORS | Phase 3.1 |
| `npm run seed:stress` / 5,000-seat layout | Phase 3.5 |
| `GET /api/bookings`, `GET /api/bookings/:ref` | not planned — see §15 |
| Index tuning, pool sizing, dropping the redundant index | Phase 7.3b (approval-gated) |
| Rate limiting on booking creation | `BACKLOG.md` P2 |
| Partial-hold handling, group-seating rules, dynamic pricing | `BACKLOG.md` P2 |
| Test framework | see D8 |
| Changes to `PLAN.md`, `BACKLOG.md`, `CLAUDE.md`, `.claude/`, `render.yaml`, `docker-compose.yml`, `.gitignore`, `.nvmrc` | none — control files |

---

## 4. Module order

### 2.1 — Naive booking endpoint

**Goal.** A working, authenticated booking endpoint that is deliberately racy:
a separate availability `SELECT`, then an `INSERT`, with nothing between them
that could serialise.

**Files.**

| File | Action |
|---|---|
| `server/src/services/bookingService.js` | new — both modes live here; only `naive` is implemented in 2.1 |
| `server/src/routes/bookings.js` | new — `POST /`, behind `requireAuth` |
| `server/src/app.js` | modify — mount `/api/bookings` (one line) |
| `server/src/config/env.js` | modify — `bookingMode`, defaulting to `'safe'`, plus the production guard |
| `server/src/lib/validate.js` | modify — `seatIdList()` |
| `.env.example` | modify — `BOOKING_MODE` |

**Endpoint.**

```
POST /api/bookings   Bearer <token>
  { "show_id": "1", "seat_ids": ["12", "13"] }

  201 { booking: { booking_ref, show_id, status, total_paise,
                   seats: [{id, row_label, seat_number, tier, price_paise}] } }
  400 VALIDATION_ERROR      malformed body, empty or oversized seat list,
                            duplicate seat ids in the request
  401 UNAUTHENTICATED
  404 NOT_FOUND             unknown show, or a seat that is not on this show's screen
  409 SEATS_UNAVAILABLE     at least one seat is already taken
  501 NOT_IMPLEMENTED       BOOKING_MODE=safe, until 2.4 lands
```

> **The 501 is superseded.** It was the Module 2.1 contract only. Module 2.4
> implemented the safe path, so `BOOKING_MODE=safe` now returns 201 / 409 like
> the naive path and no code path returns 501. Decisions D3 and Q2 are left as
> written — they record why the stub existed, and that reasoning still holds.

`booking.status` is `'pending'` — Phase 5 owns the transition to `'paid'`.
`booking_ref` is generated in the application from `node:crypto`; no new
dependency.

**The naive path, exactly.**

1. Resolve the show (`catalogService.getShowWithScreen`) — 404 if unknown.
2. Resolve the requested seats against `seats` for that show's `screen_id` —
   404 if any id does not belong to this show's screen.
3. Read availability via **`availabilityService.getSeatStatus(showId)`** and
   reject with 409 if any requested seat is not `'available'`.
4. `INSERT INTO bookings ...` (autocommit).
5. `INSERT INTO booking_seats ...` (autocommit, separate statement).

No transaction. No `ON CONFLICT`. No `FOR UPDATE`. No advisory lock. No
`INSERT ... WHERE NOT EXISTS`. Step 3 is a plain read that takes no locks, and
nothing in the database rejects step 5. **This is the protected defect** — see
`CLAUDE.md` §10 and R4.

Step 3 goes through `availabilityService` because that service owns seat-status
truth (Phase 1 D4/constraint 5). It reads the whole seat map for the show,
which is both the honest reuse of Phase 1's boundary and a meaningfully wide
race window. That is recorded in the methodology (§9), not hidden.

**Isolation assertion.** Both modes run
`show transaction_isolation` on the connection they are about to use and export
the value; it is logged once at first booking and recorded in §9. `PLAN.md` 2.1
requires this to be asserted rather than assumed. Local Postgres 17.11 currently
reports `read committed` (measured, §16 V4) — the assertion exists so a future
environment that differs is caught rather than silently changing the result.

**Done when.** A booking succeeds and appears in `booking_seats`; the seat then
reports `booked` on `/api/shows/:id/seatmap`; booking an already-booked seat
returns 409 through the pre-check; unauthenticated → 401; a seat from another
screen → 404; and **two sequential requests racing by hand** (two shells, both
past the pre-check before either inserts) both succeed — the defect confirmed
by construction, before k6 exists.

**Model / effort.** Opus / medium. Small, but every instinct toward "correct"
code is wrong here.

---

### 2.2 — k6 contention script

**Goal.** A committed script that puts N virtual users on the same seat
simultaneously, and committed SQL that counts what went wrong.

**Files.**

| File | Action |
|---|---|
| `loadtest/seat-contention.js` | new — the k6 script |
| `loadtest/count-double-bookings.sql` | new — the counting query |
| `loadtest/README.md` | new — how to run it, and against what |

**Script shape.** 500 VUs, `scenarios.contention` with
`executor: 'per-vu-iterations'`, 1 iteration per VU, so exactly 500 booking
attempts are attempted and any shortfall shows up as `dropped_iterations`.
`setup()` logs in the demo account once and shares one token — the contention
under test is on the seat, not on distinct identities. Show id, seat id, base
URL and VU count come from environment variables with defaults.

**No aborting thresholds.** A threshold that stops the run would destroy the
measurement. The script records rather than judges.

**Recorded from every run:** `iterations`, `dropped_iterations`,
`http_req_failed`, `http_req_duration` (avg/p95/max), and a per-status-code
counter (201 / 409 / 4xx / 5xx). `PLAN.md` 2.3 is explicit: "0 double-bookings"
means nothing if the load never landed.

**Counting SQL.**

```sql
-- Seats claimed more than once for the same show.
select bs.show_id, bs.seat_id, count(*) as claims
from booking_seats bs
join bookings b on b.id = bs.booking_id
where b.status <> 'cancelled'
group by bs.show_id, bs.seat_id
having count(*) > 1
order by claims desc;

-- The headline number: rows that should not exist.
select coalesce(sum(claims - 1), 0) as double_bookings
from (
  select count(*) as claims
  from booking_seats bs
  join bookings b on b.id = bs.booking_id
  where b.status <> 'cancelled'
  group by bs.show_id, bs.seat_id
) t
where claims > 1;
```

The `status <> 'cancelled'` filter matches `availabilityService` exactly, so the
count means "seats the system considers sold twice", not "duplicate rows".

**Done when.** The script runs end to end against a local server with a small VU
count (e.g. `VUS=5`), the counting SQL executes, and `loadtest/README.md`
states the ports, the environment, and the "never against Neon or Render" rule.
**No baseline number is claimed in 2.2** — that is 2.3's job.

**Model / effort.** Sonnet / low-medium.

---

### 2.3 — Baseline run

**Goal.** The before-number, measured, with its method recorded.

**Files.**

| File | Action |
|---|---|
| `loadtest/results/2.3-naive-<date>.json` | new — raw k6 summary export |
| `docs/phases/phase-2-booking-core.md` | modify — §9 results table |

No application code changes.

**Procedure (exact, in order).**

1. Confirm the local database is at migration `001` only and freshly seeded.
2. Record the environment (§9 template) *before* running.
3. Start the server in WSL with `BOOKING_MODE=naive`, `NODE_ENV=development`.
4. Run `loadtest/seat-contention.js` with 500 VUs, `--summary-export`.
5. Run `loadtest/count-double-bookings.sql`.
6. Record: double-booking count, 201 count, 409 count, dropped iterations,
   http_req_failed, durations, and the asserted isolation level.

**Environment.** Local Docker Postgres on **port 5433** and Redis on **6380**
(Phase 0 remapped these). `collab-postgres` and `collab-redis` hold the default
ports; Phase 0's close-out recommends stopping them during benchmark runs so two
Postgres instances are not competing for disk. **Authorized under Q6:** they may
be stopped temporarily, **no volume or data is deleted**, and they are restarted
once the measurement is taken. Whether they were running is recorded with the
number either way.

**Never against Neon or Render.** A naive run would write real duplicate rows
into the production database and benchmark free-tier throttling instead of the
system. `PLAN.md` 2.3 forbids it.

**Done when.** A non-zero double-booking count is recorded together with proof
the load landed. If the count is zero, the phase stops and reports — a zero
before-number means the race did not reproduce, and the endpoint or the method
is wrong, not the plan.

**Model / effort.** Opus / medium. The measurement discipline is the work.

---

### 2.4 — The fix

**Goal.** Make double-booking impossible at the database, and turn the violation
into a clean 409.

**Files.**

| File | Action |
|---|---|
| `server/migrations/002_unique_booking_seats.sql` | new |
| `server/src/services/bookingService.js` | modify — implement the `safe` path |

**Migration.**

```sql
alter table booking_seats
  add constraint booking_seats_show_id_seat_id_key unique (show_id, seat_id);
```

This creates a unique index that makes `booking_seats_show_id_seat_id_idx`
(Phase 1) redundant. **It is deliberately not dropped here** — index changes are
Phase 7.3b and approval-gated. Recorded as a deferred finding (§15).

**The migration will fail if 2.3's duplicate rows are still present.** The
database must be re-seeded (which truncates) before `002` is applied. That is
the correct order and is stated in §14, not discovered at runtime.

**The safe path, exactly.**

1. Resolve show and seats as in 2.1.
2. Pre-check via `availabilityService` → 409 if any seat is taken. This is UX,
   not the guarantee, and the code says so.
3. `BEGIN`
4. `INSERT INTO bookings ... RETURNING id`
5. One multi-row `INSERT INTO booking_seats (booking_id, show_id, seat_id)`,
   with seat ids **sorted ascending** so two overlapping transactions always
   take the index entries in the same order.
6. `COMMIT`
7. On error: `ROLLBACK`, then classify.

**Error classification — by constraint name, not by code alone.** `23505` is
also what a `booking_ref` collision raises. Only
`err.constraint === 'booking_seats_show_id_seat_id_key'` becomes
`409 SEATS_UNAVAILABLE`; a `booking_ref` collision is retried once and otherwise
surfaces as a 500. `40P01` (deadlock) is mapped to `409 SEATS_UNAVAILABLE` as a
backstop — sorted inserts should prevent it, and any occurrence is recorded, not
swallowed silently.

Both the pre-check 409 and the constraint 409 return the **same** code. A client
must not have to know which layer caught it.

`booking_seats.show_id` is set from the same resolved show as `bookings.show_id`
inside the one transaction, closing Phase 1's R2 denormalisation risk.

**Done when.** `npm run migrate` applies `002` on a clean database and is a
no-op on re-run; `pg_indexes` shows a unique index on `(show_id, seat_id)`; two
conflicting inserts by hand now produce exactly one success and one `23505`;
`BOOKING_MODE=safe` returns 201 then 409 for the same seat; and
`BOOKING_MODE=naive` against a constrained database now returns 409 rather than
double-booking — which is exactly why the before-number needs §14's procedure.

**Model / effort.** Opus / high. This is the phase's headline mechanism.

---

### 2.5 — Verification run

**Goal.** The after-number, under an identical workload, and the two numbers
written down together.

**Files.**

| File | Action |
|---|---|
| `loadtest/results/2.5-safe-<date>.json` | new — raw k6 summary export |
| `docs/phases/phase-2-booking-core.md` | modify — close-out |
| `README.md` | modify — benchmark table, **separately authorized commit** |

**Procedure.** Fresh seed → `npm run migrate` (applies `002`) → server with
`BOOKING_MODE=safe` → the *same* k6 invocation, same VU count, same show and
seat → counting SQL. Expected: `double_bookings = 0`, exactly one `201`, the
remainder `409`, and `dropped_iterations` no worse than the baseline.

Then, on the same constrained database, a short `BOOKING_MODE=naive` run to
record what the constraint does to the naive path (expected: no duplicates, some
5xx from the uncaught `23505`). This is a **third** data point, labelled as such
— it is not the before-number.

**Done when.** §9's table has both rows filled, each with its method and its raw
summary file, and `README.md` carries the same two numbers with the command
beside them.

**Model / effort.** Opus / medium.

**Phase effort:** ~1 day, dominated by 2.3 and 2.5 measurement discipline.

---

## 5. Database migrations / schema changes

One migration, one statement.

| File | Statement | Applied to |
|---|---|---|
| `server/migrations/002_unique_booking_seats.sql` | `alter table booking_seats add constraint booking_seats_show_id_seat_id_key unique (show_id, seat_id)` | local at 2.4; **Neon manually at close-out** (Phase 1 pattern Q3) |

No new tables. No new columns. No altered columns. No dropped indexes.
`bookings.status` and `booking_ref` are used as Phase 1 defined them; `status`
stays `'pending'` and its `CHECK` is unchanged.

**Neon.** Currently 11 booked seats, no duplicates, so `002` applies cleanly.
Applying it is a production schema change and needs explicit authorization at
close-out (Q7).

---

## 6. Dependencies requiring approval

**None. Zero new npm packages.**

| Need | Satisfied by |
|---|---|
| Load generation | k6 **v2.2.0**, already installed in WSL at `/home/vivek/.local/bin/k6` (Phase 0.1). A standalone binary — not an npm dependency, not in any manifest |
| `booking_ref` generation | `node:crypto` (built in) |
| Input validation | existing `server/src/lib/validate.js` |
| Transactions | existing `pg` pool |
| Auth on the endpoint | existing `requireAuth` |
| Availability read | existing `availabilityService` |

`package.json`, `server/package.json`, and `package-lock.json` are **not
modified by any module in this phase.** If that changes, it is a stop condition.

---

## 7. Concurrency / race-condition requirements

### The race, precisely

Under **READ COMMITTED** (verified, §16 V4):

- A plain `SELECT` takes no row locks. Two sessions checking the same seat both
  see it free.
- Neither sees the other's uncommitted `INSERT`.
- With no unique index on `(show_id, seat_id)`, nothing in the database rejects
  the second insert.

The window is `check → insert`, and 2.1 makes it as wide as an honest
implementation makes it — the availability read fetches the show's full seat map
through `availabilityService`.

### Why `UNIQUE` fixes it

An index insertion on a duplicate key blocks until the first transaction ends.
On commit, the second raises `23505`. The check is no longer advisory: the
database refuses. The pre-check remains only so the common case gets a clean 409
without touching a transaction.

### Requirements binding on the implementation

1. **Naive mode must remain genuinely racy.** No `ON CONFLICT`, `FOR UPDATE`,
   advisory lock, `WHERE NOT EXISTS`, serialisable isolation, or retry loop on
   that path — now or ever.
2. **Safe mode's guarantee is the constraint, not the pre-check.** If the
   pre-check were removed, correctness must be unaffected. State this in the
   code.
3. **Multi-seat bookings are all-or-nothing** — one transaction, one
   `booking_seats` statement.
4. **Deterministic lock order** — seat ids sorted ascending before insert.
5. **Isolation asserted at runtime**, not assumed, and recorded with every
   measurement.
6. **`23505` is classified by constraint name.**
7. **`40P01` is handled and recorded**, never silently retried into success.
8. **Both 409 paths return the same error code.**
9. **`bookings.show_id` and `booking_seats.show_id` are written from one
   resolved value in one transaction.**

### Alternatives considered and rejected (recorded now for Phase 8.2)

| Alternative | Why rejected |
|---|---|
| `SELECT ... FOR UPDATE` on the `seats` rows | Locks a row that describes a seat's *identity*, not its availability for a given show. Correct only by convention, and it serialises every show on the same physical seat |
| `SERIALIZABLE` isolation | Works, but pushes the failure to `40001` with application-level retry, and costs on every transaction rather than only on conflict |
| Postgres advisory locks keyed on `(show_id, seat_id)` | No schema change, but the guarantee lives in application code — any path that forgets the lock reintroduces the bug |
| `INSERT ... ON CONFLICT DO NOTHING` | Would work *after* the constraint exists, but silently books fewer seats than requested unless the returned row count is checked. The explicit `23505` catch is louder |
| Application-level mutex / queue | Correct on one instance, wrong the moment there are two (`BACKLOG.md` P2) |

**The chosen guarantee is the unique constraint.** Everything else — the
pre-check now, Redis holds in Phase 4 — is an optimisation layered above it.

---

## 8. The intentional `booking_seats` defect

`CLAUDE.md` §10 protects three things. Phase 2 touches all three.

| Protected item | How Phase 2 treats it |
|---|---|
| `booking_seats` has no unique constraint (1.2) | Left intact through 2.1–2.3, where it is the object of measurement. **2.4 is the only module authorized to change it**, and only via `002_unique_booking_seats.sql` |
| The naive endpoint is deliberately racy (2.1) | Built racy on purpose, verified racy in 2.3, and **not** hardened afterwards |
| `BOOKING_MODE=naive\|safe` is permanent | The naive branch stays in `bookingService.js` after 2.4. It is not dead code to be cleaned up; without it the before-number can never be re-measured |

**Anti-fix guard.** The naive branch carries a comment naming `PLAN.md` 2.1 and
`CLAUDE.md` §10 and stating that its "bug" is the measurement. Any later change
to that branch is a stop condition.

**Honest caveat.** Once `002` is applied, `BOOKING_MODE=naive` no longer
produces double-bookings — the database rejects them. Reproducing the
before-number needs a database at migration state `001` as well as the env var.
See §14 and M1.

---

## 9. Verification strategy

Targeted per module; the full sequence runs once at close-out. Everything local:
**Docker Postgres 17.11 on port 5433, Redis on 6380.**

| Module | Checks |
|---|---|
| 2.1 | 201 creates one `bookings` row and N `booking_seats` rows · the seat then reports `booked` on the seat map · same seat again → 409 · no token → 401 · seat from another screen → 404 · duplicate seat id in the request → 400 · **hand-run race in two shells → both succeed** · `/health`, `/`, and the three Phase 1 read endpoints unchanged · `BOOKING_MODE=safe` → 501 |
| 2.2 | script runs at `VUS=5` against a local server · counting SQL executes · summary export written |
| 2.3 | full baseline run, table below filled, raw summary committed |
| 2.4 | `migrate` applies `002`, re-run is a no-op · `pg_indexes` shows the unique index · two conflicting inserts by hand → one success, one `23505` · safe mode 201 then 409 · a `booking_ref` collision does **not** return 409 |
| 2.5 | full verification run · `double_bookings = 0` · exactly one 201 · load confirmed landed · naive-on-constrained-DB third data point recorded |

**Phase close-out, run once, in order:** fresh database → `migrate` (001 only) →
`seed` → naive baseline → count → fresh seed → `migrate` (002) → safe run →
count → Phase 1 regression sweep (`/`, `/health`, movies, shows, seatmap,
register, login, `/me`) → deployed verification (§13).

### Results table — to be filled by 2.3 and 2.5

Both rows measured. 3 runs each, 500 VUs, one seat, identical workload.

| Metric | Before (naive) | After (safe) | Method |
|---|---|---|---|
| **Double-booked seats** | **303 / 150 / 303** | **0 / 0 / 0** | `loadtest/count-double-bookings.sql` |
| Successful bookings (201) | 304 / 151 / 304 | 1 / 1 / 1 | k6 status counter |
| Rejected (409) | 196 / 349 / 196 | 499 / 499 / 499 | k6 status counter |
| 5xx | 0 / 0 / 0 | 0 / 0 / 0 | k6 status counter |
| `dropped_iterations` | 0 / 0 / 0 | 0 / 0 / 0 | k6 summary |
| `http_req_failed` | 0% / 0% / 0% | 0% / 0% / 0% | k6 summary |
| `http_req_duration` p95 | 1090.4 / 911.9 / 994.6 ms | 1139.5 / 734.9 / 831.9 ms | k6 summary |

Raw evidence: `loadtest/results/2.3-naive-2026-08-19.json` and
`loadtest/results/2.5-safe-2026-08-19.json`.

**Third data point — `BOOKING_MODE=naive` against a database that already has
the `002` constraint.** Not the before-number; it exists to separate the
constraint from the error handling.

| Metric | Value |
|---|---|
| Double-booked seats | **0** |
| 201 / 409 / 5xx | 1 / 195 / **304** |
| `dropped_iterations` | 0 |

The naive code is unchanged; only the schema beneath it differs. The database
refused every duplicate, and because that path does not catch `23505` the
refusals surfaced as 5xx. The constraint is what prevents the double-booking;
the safe path is what turns the rejection into a clean 409.

**Latency is reported, not claimed.** 500 VUs against a pool of 10 measures
queueing. These p95 figures are not a throughput or capacity result, and the
before/after latency difference is not a performance improvement — the two
paths do different amounts of work per request.

**Method recorded with both rows:** machine and OS · WSL2 Ubuntu · Node
v22.23.2 · Postgres 17.11 (`postgres:17-alpine`, port 5433) · k6 v2.2.0 ·
`pg.Pool` max (default **10** — see R2) · transaction isolation as asserted at
runtime · VU count · show id and seat id · commit SHA · date · whether
`collab-*` containers were running.

**Everything above is "Not measured." until a recorded command produces it.**
No number enters this document, `README.md`, or a commit message from an
estimate.

**Not verified by this phase, and not to be claimed:** hold behaviour, Redis
under load, WebSocket anything, production throughput, capacity ceilings,
multi-instance correctness, or query latency beyond what k6 reports.

---

## 10. Design decisions

**D1 — `BOOKING_MODE` defaults to `safe`.** An unset variable must never deploy
the racy path. Also: the server **refuses to start** when
`BOOKING_MODE=naive` and `NODE_ENV=production`. `PLAN.md` requires the naive
path to be permanent, not reachable in production. *(Needs approval — Q1.)*

**D2 — No `render.yaml` change.** With D1's default, production is safe without
declaring the variable, so a control file stays untouched and Phase 1's open
finding H1 is not compounded. *(Q1.)*

**D3 — 2.1 ships `naive` only; `safe` returns 501 until 2.4.** A `safe` branch
without the constraint would be a lie in the code. Module order over
convenience. *(Q2.)*

**D4 — The availability read goes through `availabilityService`.** Constraint 5
is binding, and reusing it means no second query path is introduced. Its cost is
recorded in the methodology rather than optimised away.

**D5 — `booking.status` is `'pending'`; Phase 2 never writes `'paid'`.** Phase 5
owns that transition. `updated_at` is left at its default (Phase 1 deferred
finding, unchanged here).

**D6 — Missing tier price fails closed.** `show_prices` is `LEFT JOIN`ed in
Phase 1, so a tier without a price yields `null`. Phase 2 computes `total_paise`
with an inner join and raises `500 INTERNAL_ERROR` if any seat resolves no
price. Silently booking at zero would be worse than a 500. *(Recorded, not a
schema change.)*

**D7 — Max 6 seats per booking, enforced server-side.** `PLAN.md` 3.3 puts the
max-6 rule in the UI hook; a rule enforced only in the browser is not a rule.
400 `VALIDATION_ERROR`. *(Needs approval — Q3; it is a contract decision
`PLAN.md` locates in Phase 3.)*

**D8 — Still no test framework.** Phase 1's Q4 deferred the decision to Phase 2.
Phase 2's correctness claim is a concurrency claim, and a unit test cannot make
it — k6 plus SQL is the right instrument. Recommend keeping verification as
scripted HTTP and SQL with recorded output. *(Q4.)*

**D9 — No `lib/ids.js` extraction.** `bookingService` imports `isId` from
`catalogService`, as `availabilityService` already does. Phase 1 logged the
extraction as a low-priority finding; doing it here is an unrelated refactor.

**D10 — No show start-time check.** Nothing in `PLAN.md` forbids booking a show
that has started, seeded day-0 shows can be in the past (Phase 1 finding), and
such a check would break the load test. Recorded as a known limitation.

---

## 11. Phase 0/1 contracts preserved

Binding, carried forward, and verified in the close-out sweep:

1. **`GET /` and `GET /health` shapes are frozen.** `render.yaml` health-checks
   `/`. Phase 2 adds no middleware ahead of them.
2. **Error contract `{error:{code,message}}`** across `/api/*`. Phase 2 adds
   `SEATS_UNAVAILABLE` and `NOT_IMPLEMENTED`; it changes no existing code.
3. **Raw SQL via `pg`.** No ORM, no query builder.
4. **`seats` owns seat identity.** Seat ids in a request are validated against
   `seats` for the show's screen; the layout JSON is never consulted.
5. **`availabilityService` owns seat-status truth.** `bookingService` calls it
   and does not grow its own availability query. The seat-map response shape is
   unchanged — Phase 2 adds no new `status` value.
6. **`.env.example` is the single source of truth for env vars.** `BOOKING_MODE`
   is added there in 2.1.
7. **`bookings.status` / `booking_ref`** are used as Phase 1 defined them.
8. **`server/` + `client/` layout.** `client/` is Phase 3.1's; not created.
9. **No secrets committed.**
10. **No AI attribution** in any commit or file.
11. **The read endpoints stay public and unauthenticated;** only the new write
    endpoint requires a token.

---

## 12. Risks and failure modes

**R1 — `002` fails on a database polluted by the baseline run.** The migration
is not conditional, and 2.3 deliberately creates duplicate rows. *Mitigation:*
§14's ordering is explicit — re-seed (which truncates) before applying `002`.
The failure is loud and the runner rolls back, so the risk is lost time, not a
corrupt schema.

**R2 — Pool size caps real concurrency.** `db/pool.js` uses `pg`'s default
`max: 10`. 500 VUs therefore contend for 10 server-side connections, and the
naive path takes **two** separate checkouts (check, then insert), which is what
keeps the race alive. The before-number is a measurement *of this
configuration*, not of Postgres's ceiling. *Mitigation:* record `max: 10` with
both numbers and claim nothing about capacity. Changing it is architecture and
goes through Phase 7.3b.

**R3 — Environment split.** The repository lives on the WSL filesystem, k6 and
Node are installed **inside WSL**, and Docker publishes to Windows `localhost`.
A run split across Windows and WSL would measure network paths, not the system.
*Mitigation:* server, `migrate`, `seed`, `psql` and k6 all run inside WSL for
every measured run, and §9's method line records it.

**R4 — "Helpfully" fixing the naive path.** The single highest risk in the
phase, and the direct analogue of Phase 1's R1. Adding `ON CONFLICT`, a
transaction, or a lock to naive mode destroys a non-negotiable measurement
permanently. *Mitigation:* the anti-fix comment (§8) and 2.1's hand-run race
check, which fails loudly if the path was accidentally made correct.

**R5 — Running the load test against Neon or Render.** Would write real
duplicates into production and measure free-tier throttling.
*Mitigation:* `loadtest/README.md` states the rule; the script's default base
URL is `http://localhost:3000` and it has no production default.

**R6 — Zero double-bookings in the baseline.** If 500 VUs produce no duplicate,
the race did not reproduce — likely a serialising accident in 2.1, or the load
never landed. *Mitigation:* `dropped_iterations` and `http_req_failed` are
recorded first; the hand-run two-shell race in 2.1 proves the defect exists
before k6 is trusted. A zero baseline is a **stop and report**, never a number.

**R7 — `booking_ref` collisions read as seat conflicts.** Both raise `23505`.
*Mitigation:* classification by `err.constraint` (§7 requirement 6), verified in
2.4.

**R8 — Deadlock on overlapping multi-seat bookings.** Two transactions inserting
`{A,B}` and `{B,A}` can deadlock. *Mitigation:* sorted seat ids; `40P01`
handled and recorded if it occurs anyway.

**R9 — Partial writes in naive mode.** Without a transaction, a failure between
the two inserts leaves a booking with fewer seats than requested. *This is a
property of the defect, not a bug to fix.* Recorded as a known limitation.

**R10 — Applying `002` to Neon while Phase 1 data is live.** Cleanly applicable
today (no duplicates), but it is a production schema change on a database that
also holds a stray verification account. *Mitigation:* explicit authorization
(Q7), and inspect for duplicates immediately before applying.

**Known limitations this phase will record:** no holds (Phase 4), no payment
(Phase 5), bookings stay `pending` forever, no booking read endpoints, no
cancellation, naive mode can partially book, no rate limiting, benchmarks local
only, single instance.

---

## 13. Deployment / production verification

Performed at close-out, after merge authorization, mirroring Phase 1.

**Q7 gate — binding.** Nothing below runs before the Phase 2 close-out gate, and
**every destructive Neon operation stops and asks for explicit confirmation
first** — `TRUNCATE`, re-seed, and row deletion included. This section listing
them is not authorization to perform them.

1. Confirm Neon `booking_seats` holds **no** duplicate `(show_id, seat_id)`.
2. Apply `002` to Neon manually from local (Phase 1 pattern Q3). *(Q7.)*
3. Confirm `pg_indexes` on Neon shows the unique index.
4. Deploy `main` to Render; confirm the deploy goes live and `GET /` returns
   200 (the health check path).
5. `GET /health` → 200 `{"status":"ok","db":"ok","redis":"ok"}`, byte-identical
   to the Phase 0/1 baseline.
6. Confirm `BOOKING_MODE` is unset on Render and the service therefore runs
   `safe` (D1). Log line confirms the mode at boot.
7. Against the deployed API: log in as the demo user → book a free seat → 201;
   book the same seat again → 409 `SEATS_UNAVAILABLE`; confirm the seat map now
   reports it `booked`.
8. Confirm the three Phase 1 read endpoints and the auth endpoints are unchanged.
9. **No load test against production.** Deployed verification is functional
   only; every number in this document comes from local runs.
10. Recommend removing the Phase 1 stray verification account and re-seeding
    Neon. *(Q7 — destructive: stop and ask before performing either.)*

---

## 14. Re-running both numbers (the reproduction procedure)

`PLAN.md` says both numbers are re-runnable "by flipping one env var". That is
true for the *safe* number and not for the *naive* one — see M1. The actual
procedure, which is what gets written into `README.md`:

**After (safe) — one env var, current database:**

```bash
BOOKING_MODE=safe npm start
k6 run loadtest/seat-contention.js
psql ... -f loadtest/count-double-bookings.sql
```

**Before (naive) — a database at migration state `001`:**

```bash
createdb showrush_baseline                       # scratch DB, never the main one
DATABASE_URL=...showrush_baseline npm run migrate # 001 only; 002 removed from the dir
DATABASE_URL=...showrush_baseline npm run seed
BOOKING_MODE=naive DATABASE_URL=...showrush_baseline npm start
k6 run loadtest/seat-contention.js
```

Recommended shape: `loadtest/README.md` records the exact commands, and the
`002` file is temporarily moved aside for the baseline database. See Q5 for the
alternative (a `--to` flag on the migration runner) if a single command is
preferred.

> **Superseded 2026-08-20 — `loadtest/README.md` is authoritative for the
> commands.** The block above says "`npm run migrate` — 001 only; 002 removed
> from the dir", which would mean moving a migration file out of the repository
> to take a measurement. The procedure actually used applies
> `server/migrations/001_init.sql` **directly via psql** to a disposable
> database, so `server/migrations/` is never touched and `002` is simply never
> applied. `schema_migrations` is absent in that database rather than empty,
> because the runner never runs against it.
>
> That form was executed at close-out and reproduced the race — see §22.

---

## 15. Deferred discoveries

### Phase 1 findings, evaluated against Phase 2

| Finding | Phase 2 disposition |
|---|---|
| **H1** — `JWT_SECRET` absent from `render.yaml` | **Still open.** Phase 2 adds no dashboard-only variable (D1/D2), so it does not compound. Not fixed here — `render.yaml` is a control file |
| `bookings.updated_at` has no trigger | Untouched. Phase 5 sets it explicitly (D5) |
| No automated test suite | Decision confirmed for Phase 2 (D8) |
| `isId` imported from `catalogService` | Untouched (D9) |
| Services do not guard a null `pool` | Untouched. `bookingService` follows the same existing pattern; changing it is a cross-cutting refactor |
| `booking_seats.show_id` can disagree with `bookings.show_id` | **Closed by 2.4** — both written from one resolved value in one transaction |
| Seeded day-0 shows can be in the past | Accepted (D10) |
| `show_prices` `LEFT JOIN` allows a null price | **Handled** — Phase 2 fails closed (D6). The missing `NOT NULL`/coverage constraint stays deferred |
| No CORS | Phase 3.1 |
| Stray deploy-verification account in Neon | Recommended for removal at close-out (Q7) |
| `pg` `sslmode=require` deprecation warning | Still `BACKLOG.md` material; unchanged |

### New, discovered during Phase 2 planning

```
Issue: booking_seats_show_id_seat_id_idx becomes fully redundant once 002's
       unique index exists — same columns, same order.
Why out of scope: index changes are Phase 7.3b and approval-gated.
Recommended future action: drop it in Phase 7.3b, or with explicit approval
       inside 002 if the redundancy is judged not worth carrying.
```

```
Issue: PLAN.md's "re-runnable by flipping one env var" is not achievable for
       the naive number once 002 is applied.
Why out of scope: PLAN.md is a control file.
Recommended future action: no edit to PLAN.md. The precise procedure is
       recorded in §14 and README.md instead.
```

```
Issue: No endpoint returns a user's bookings, so a booking can be created but
       not read back except through the seat map.
Why out of scope: not in PLAN.md Phase 2, and Phase 5 needs booking_ref lookup
       anyway.
Recommended future action: let Phase 5 add it, or add to BACKLOG.md.
```

---

## 16. Plan verified against the repository

Verified 2026-08-20 by direct inspection at `12be6e7`, not assumed.

| Assumption | Actually in the repository | Mismatch |
|---|---|---|
| `main` clean, at Phase 1 close-out | `main` == `origin/main` == `12be6e7`, working tree clean | none |
| `feat/booking-core` does not exist | correct — `feat/foundation`, `module/0.6-*`, `module/0.7-*` exist | none |
| `booking_seats` has no unique constraint | confirmed in `001_init.sql`; only `booking_seats_show_id_seat_id_idx`, non-unique | none |
| `availabilityService` is the single availability read | confirmed — `getSeatStatus`, `EXISTS`, filters `b.status <> 'cancelled'` | none |
| `requireAuth` available for the new endpoint | confirmed, `server/src/middleware/auth.js` | none |
| Error contract in place | confirmed, `lib/http-error.js` + `middleware/error.js` | none |
| Migration runner supports a second file | confirmed — filename-sorted, per-file transaction, `schema_migrations` | none |
| `loadtest/` does not exist | correct | none |
| No booking route or service exists | correct — `app.js` mounts health, auth, movies, shows only | none |
| k6 installed | **v2.2.0 in WSL** at `/home/vivek/.local/bin/k6`; not on the Windows PATH | **yes — M2** |
| Local Postgres on 5432 | **5433**; Redis **6380**; `collab-*` hold the defaults, all four containers currently running | **yes — M3** |
| Default isolation is READ COMMITTED | **verified**, not assumed — see V4 | none |
| No new dependency needed | confirmed — `bcryptjs`, `dotenv`, `express@5`, `jsonwebtoken`, `pg`, `redis` cover everything | none |
| Express 5 semantics | confirmed — async rejections auto-forward; no wrapper needed in `bookings.js` | none |

### Concrete problems found

**M1 — "Flip one env var" does not reproduce the before-number.** Once `002` is
applied, `BOOKING_MODE=naive` cannot double-book: the database rejects it.
`PLAN.md` 2.1's stated mechanism is incomplete. Reproduction needs a database at
migration state `001` **and** the env var. Resolved by §14's documented
procedure; `PLAN.md` is not edited. **This is the most important planning
finding in the phase.**

**M2 — k6 and Node live inside WSL; the repo is reached from Windows.** k6 is
not on the Windows PATH. Every measured run must be executed inside WSL, or the
numbers describe a cross-boundary network path. Recorded as R3 and in §9's
method line.

**M3 — Non-default ports and a competing Postgres.** 5433 / 6380, with
`collab-postgres` and `collab-redis` running on the defaults. Phase 0's close-out
recommends stopping them during benchmark runs. Stopping containers needs
permission (Q6); if they are left running, that fact is recorded with the
numbers rather than ignored.

**M4 — 2.3 poisons the database for `002`.** Sequencing consequence, not a
defect. Handled by §14 and R1.

**M5 — `pg.Pool` runs at the default `max: 10`.** 500 VUs do not mean 500
concurrent transactions. Recorded with every number (R2); not changed, because
pool sizing is Phase 7.3b architecture.

### Verified measurements taken during planning

| ID | Command | Result | Date |
|---|---|---|---|
| V1 | `git status` / `git log` at repo root | `main` == `origin/main` == `12be6e7`, tree clean | 2026-08-20 |
| V2 | `wsl -d Ubuntu -- bash -ic 'node -v; npm -v'` | `v22.23.2`, `10.9.8` | 2026-08-20 |
| V3 | `wsl -d Ubuntu -- bash -lc 'k6 version'` | `k6 v2.2.0 (go1.26.5, linux/amd64)` | 2026-08-20 |
| V4 | `docker exec showrush-postgres psql -U showrush -d showrush -c "show server_version" -c "show default_transaction_isolation"` | `17.11`, **`read committed`** | 2026-08-20 |
| V5 | same, `\dt` | 9 tables present (8 + `schema_migrations`) | 2026-08-20 |
| V6 | `docker ps` | `showrush-postgres` 5433, `showrush-redis` 6380, `collab-postgres` 5432, `collab-redis` 6379 — all up | 2026-08-20 |

These are environment facts, not benchmarks. **No performance number has been
measured. All benchmark cells in §9 read "not measured."**

> **Superseded 2026-08-20.** True when written, at planning time. Modules 2.3
> and 2.5 have since measured both numbers and §9's table is filled from the
> raw artifacts under `loadtest/results/`. The sentence above is kept because
> it records what was and was not claimed *before* any measurement existed —
> which is the point of the discipline, not an embarrassment to erase.

### Unnecessary complexity removed

- **No booking read endpoints.** Not required by the done-when criteria.
- **No `lib/ids.js`, no repository layer, no DAO.** Services own their SQL.
- **No retry/backoff layer.** A 409 is the correct answer to a lost race.
- **No new error middleware.** `HttpError` already covers both 409s.
- **No `down` migration.** Forward-only, as Phase 1 decided (D1 there).
- **No k6 thresholds, custom metrics beyond a status counter, or HTML report.**
  Raw summary JSON plus SQL is the evidence.
- **No separate `naiveBookingService`/`safeBookingService`.** One service, one
  branch on `BOOKING_MODE`, so the diff between the two paths is readable in one
  file — which is the point of the phase.

---

## 17. Files expected to change

**New (8):**

```
server/src/services/bookingService.js       2.1, extended 2.4
server/src/routes/bookings.js               2.1
server/migrations/002_unique_booking_seats.sql   2.4
loadtest/seat-contention.js                 2.2
loadtest/count-double-bookings.sql          2.2
loadtest/README.md                          2.2
loadtest/results/2.3-naive-<date>.json      2.3
loadtest/results/2.5-safe-<date>.json       2.5
```

**Modified (5):**

```
server/src/app.js            2.1 — mount /api/bookings (one line)
server/src/config/env.js     2.1 — BOOKING_MODE + production guard
server/src/lib/validate.js   2.1 — seatIdList()
.env.example                 2.1 — BOOKING_MODE
README.md                    close-out — benchmark table (separate authorized commit)
```

**This document** — created at planning, updated at 2.3, 2.5 and close-out.

Nothing else. Needing any file outside this list is a stop condition: report the
exact file, the minimum change, and wait.

---

## 18. Files that must remain untouched

`PLAN.md` · `BACKLOG.md` · `CLAUDE.md` · `.claude/settings.json` ·
`render.yaml` · `docker-compose.yml` · `.gitignore` · `.nvmrc` ·
`package.json` · `server/package.json` · `package-lock.json` ·
`server/migrations/001_init.sql` · `docs/phases/phase-0-setup.md` ·
`docs/phases/phase-1-foundation.md` · every existing file under
`server/src/routes/`, `server/src/services/`, `server/src/seed/`,
`server/src/db/`, `server/src/middleware/` **except** those named in §17.

`client/` is not created.

---

## 19. Decisions — all resolved 2026-08-20

| ID | Decision | Resolution |
|---|---|---|
| **Q1** | `BOOKING_MODE` default and production guard (D1/D2) | **Approved.** Production must never run the racy path. Default `safe`; the server refuses to start on `naive` + `NODE_ENV=production`; naive is enabled **only explicitly**, for the controlled baseline experiment. No `render.yaml` change |
| **Q2** | Does 2.1 ship a `safe` branch, or 501 until 2.4? (D3) | **Approved.** `501 NOT_IMPLEMENTED` until 2.4's transaction and unique constraint exist |
| **Q3** | Enforce max 6 seats per booking server-side? (D7) | **Approved.** Server-side maximum of 6, `400 VALIDATION_ERROR`. Recorded as a deliberate deviation from `PLAN.md` 3.3, which locates the rule in the UI |
| **Q4** | Add a test framework at Phase 2, as Phase 1's Q4 deferred? (D8) | **No.** Focused scripted HTTP + SQL + k6 verification, with recorded output |
| **Q5** | Baseline reproduction mechanism (M1, §14) | **Option A.** A database at migration state `001` for the naive baseline, with the exact procedure documented in §14 and `loadtest/README.md`. No change to `migrate.js`. The document must not claim `BOOKING_MODE` alone reproduces the baseline once `002` exists |
| **Q6** | Stop `collab-postgres` / `collab-redis` during the measured runs? | **Authorized, conditionally.** They may be stopped temporarily to obtain uncontested measurements. **No volume or data deletion**, and they are restarted afterwards. Whether they were running is recorded with every number |
| **Q7** | Neon at close-out: apply `002`, remove the stray verification account, re-seed? | **Gated.** Neon migration, production verification, cleanup, and re-seed happen only at the appropriate Phase 2 gate. **Any destructive Neon operation — `TRUNCATE`, re-seed, row deletion — requires stopping and asking for explicit confirmation first.** This plan mentioning them is not authorization |
| **Q8** | Branch and commit shape | **Approved.** `feat/booking-core` created from `main` @ `12be6e7`; one commit per module, plus a separately authorized `README.md` commit at close-out |
| **Q9** | Is this document committed? | **Yes.** Committed on `feat/booking-core` before Module 2.1 begins, matching how Phase 1's plan document is tracked |

---

## 20. Phase 2 close-out gate

Merge to `main` is requested only when **every** line below is true and recorded.

Ticked at close-out, 2026-08-20, against the state at `2c028b6`. Evidence for
each is in §22.

- [x] All five modules implemented, one commit each on `feat/booking-core`
- [x] Per-module verification recorded PASS / FAIL / NOT RUN / NOT VERIFIED
- [x] `POST /api/bookings` works in both modes; `naive` still racy, `safe` correct
- [x] `002` applied locally; `pg_indexes` confirms the unique index
- [x] **Before-number recorded**, non-zero, with proof the load landed
- [x] **After-number recorded as 0**, same workload, same VU count
- [x] Both raw k6 summaries committed under `loadtest/results/`
- [x] Method recorded in full for both runs (§9 method line)
- [x] `loadtest/` committed: script, counting SQL, README with the reproduction
      procedure (§14)
- [ ] `README.md` benchmark table carries both numbers with their commands
      — **outstanding**, close-out item 3, separately authorized commit
- [x] The naive path is present, functional, and un-hardened after 2.4
- [x] Phase 1 regression sweep passed: `/`, `/health`, movies, shows, seatmap,
      register, login, `/me`
- [x] `/health` and `GET /` byte-identical to the Phase 0/1 baseline
- [x] No out-of-scope file touched; `package*.json` unmodified; zero new
      dependencies
- [x] No control file modified
- [ ] `002` applied to Neon and confirmed (authorized separately)
      — **outstanding**, close-out item 5, requires explicit authorization
- [ ] Deployed verification passed (§13), functional only — no production load test
      — **outstanding**, close-out items 6 and 7
- [x] Deferred findings recorded; nothing silently fixed
- [x] `git status` clean of `.env` and `node_modules`; no secrets tracked
- [x] No AI attribution in any commit or file
- [x] This document updated with the close-out section
- [x] Integration review across Phase 0/1/2 performed and reported
- [x] Merge **not** performed until explicitly authorized — not merged

**Non-negotiable:** if the before-number is not reproducible by the §14
procedure at close-out, the phase is not done. `PLAN.md` names it as one of two
things that must never be cut.

---

## 21. Module 2.5 — verification run record

**Status:** MEASURED · 2026-08-19 UTC (2026-08-20 IST) · commit `3946e16`
**Artifact:** `loadtest/results/2.5-safe-2026-08-19.json`

### What was run

Fresh disposable database → `migrate` (`001` + `002`) → seed → server with
`BOOKING_MODE=safe` → the same k6 invocation as the baseline (500 VUs, one
iteration each, 3 s barrier, show 1, seat 3, `http://localhost:3000`) → the
counting SQL. Repeated three times, re-seeded before each run.

Conditions were matched to the baseline deliberately: same machine, same Node,
k6 and Postgres versions, same pool default of 10, `read committed` asserted at
runtime, and `collab-postgres` / `collab-redis` stopped for the duration and
restarted afterwards — as they were for 2.3.

### Result

**0 double-bookings in all three runs.** Exactly one 201 and 499 409s each
time, with 0 dropped iterations, 0 5xx and 0 no-response — so the zero is a
result, not an absence of load. The full table is in §9.

### Deliberate choices worth recording

**A disposable database, not the dev database.** `002` is the point after which
`BOOKING_MODE=naive` stops double-booking on that database. Measuring on a
throwaway leaves the main dev database at `001`, so the before-number remains
reproducible in place rather than only via §14. The dev database was verified
untouched afterwards: still `001`, still 5 bookings / 11 booking_seats.

**Three runs, not one.** The baseline varied (303, 150, 303) because a race is
stochastic. The safe number does not vary, and could not — but running it once
would not have shown that.

**The third data point.** `BOOKING_MODE=naive` on a constrained database:
1 created, 195 pre-check 409s, 304 5xx, 0 double-bookings. It separates the two
things 2.4 changed. The constraint alone is what prevents the double-booking;
the safe path is what turns the rejection into a clean 409 rather than a 500.
This is **not** the before-number and is labelled as such everywhere it appears.

### Discovered, deferred

```
Issue: recordIsolation()'s memoisation is racy. Under 500 concurrent first
       bookings the guard is read before it is set, so the isolation level was
       queried and logged 92 times in a single run rather than once.
Why out of scope: it is log noise, not a correctness problem. The level is
       still asserted and still recorded, and the value is identical every
       time. Fixing it means touching the booking path, which 2.5 must not do
       after the measurement.
Recommended action: guard with an in-flight promise rather than a resolved
       value. Small, and belongs to a later module or BACKLOG.md.
```

```
Issue: the peak-concurrent-backends observation recorded in the 2.3 artifact
       was not captured for 2.5 — the sampler did not write its output.
Why out of scope: it was labelled an observation, not a controlled
       measurement, in 2.3 as well. No claim in either artifact depends on it.
Recommended action: none required. If symmetry matters at close-out, re-run
       the sampler alone; it does not require re-running the measurement.
```

### Not done by this module

`README.md`'s benchmark table still carries neither number. §17 marks that a
**separately authorized commit**, and it remains outstanding — the 2.5
done-when criteria are not fully met until it lands.

---

## 22. Phase close-out

**Status:** IMPLEMENTED, MEASURED and REVIEWED. **Not merged, not deployed.**
**Completed:** 2026-08-20 · branch `feat/booking-core` @ `2c028b6`
**Outstanding before merge:** close-out items 3, 5, 6 and 7 (see the end of this
section).

Phase 2 set out to produce two defensible numbers and a documented method for
reproducing both. It has them: **150–303 double-booked seats before, 0 after**,
under an identical 500-VU workload, both re-runnable today.

### Built

| Module | Commit | What landed |
|---|---|---|
| 2.1 Naive booking endpoint | `3aaf36b` | `services/bookingService.js`, `routes/bookings.js`; `BOOKING_MODE` in `config/env.js` with a production guard; `seatIdList`/`idValue` in `lib/validate.js`; one mount line in `app.js`; `.env.example`. Deliberately racy check-then-insert |
| 2.2 k6 contention script | `a372d09` | `loadtest/seat-contention.js`, `loadtest/count-double-bookings.sql`, `loadtest/README.md` |
| — corrective | `2bcba13` | `handleSummary` strips `setup_data.token` before writing any summary — see "Security incident" below |
| 2.3 Baseline run | `76ae650` | `loadtest/results/2.3-naive-2026-08-19.json` — the before-number |
| 2.4 The fix | `3946e16` | `server/migrations/002_unique_booking_seats.sql` and `createBookingSafe` |
| 2.5 Verification run | `2c028b6` | `loadtest/results/2.5-safe-2026-08-19.json` — the after-number, and §21 |

Plus `67cc222`, this document. Seven commits, 13 files, **4149 insertions and
zero deletions** — no Phase 0 or Phase 1 code was removed or rewritten.

### The two numbers

| Metric | Before — `naive` | After — `safe` |
|---|---|---|
| Double-booked seats (3 runs) | **303, 150, 303** | **0, 0, 0** |
| 201 / 409 per run | 304/196 · 151/349 · 304/196 | 1/499 × 3 |
| Dropped iterations · 5xx · no-response | 0 · 0 · 0 | 0 · 0 · 0 |

Identical workload both sides: 500 VUs, `per-vu-iterations`, one iteration each,
3 s start barrier, show 1, seat 3, fresh seed before every run, `pg.Pool` at the
default max of 10, `read committed` asserted by the server at runtime, local
Docker Postgres 17.11 on port 5433, k6 v2.2.0, Node v22.23.2, `collab-*`
containers stopped for the duration of every measured run.

The zero is a result, not an absence of load: all 500 iterations ran and were
answered in every run on both sides.

### Verification performed

| Gate | Result |
|---|---|
| Module 2.1 contract — 49 checks (auth, validation, max-6, unknown show/seat, foreign-screen seat, already-booked, duplicate seats, `booking_ref` uniqueness, mode guards, 501 stub, Phase 0/1 regression, no `password_hash` leakage, no schema drift) | **49/49 PASS** |
| Module 2.1 race, by hand | **PASS** — reproduced at two concurrent clients |
| Module 2.2 instrument checks | **PASS** — runs, targets the right endpoint, contends, does not serialise, guards refuse a taken/foreign seat and a dead server |
| Module 2.3 baseline | **PASS** — 303 / 150 / 303, every figure traced back to the embedded raw k6 summaries |
| Module 2.4 | **PASS** — `002` applies and is a no-op on re-run; unique index confirmed; `booking_ref` collision does not return 409 |
| Module 2.5 verification | **PASS** — 0 / 0 / 0 |
| §14 before-number reproduction, at close-out | **PASS** — 288 / 256 / 70 double-bookings on a fresh database at `001`, non-zero every run, unique-index absence asserted before and after |
| Phase 0/1/2 integration review | **PASS** — no critical or high findings |

**Not verified, and not claimed:** production or deployed behaviour, throughput,
capacity ceilings, behaviour above 500 VUs or with a larger pool, hold or Redis
behaviour, multi-instance correctness.

### §14 reproduction, re-run at close-out

The before-number is reproducible, which `PLAN.md` names as non-negotiable. On a
disposable database at schema `001` (0 unique indexes on `(show_id, seat_id)`,
asserted before and after), three runs of the identical workload produced
**288, 256 and 70** double-bookings, 0 dropped, 0 5xx.

Runs 1 and 2 sit inside the recorded 150–303 range; run 3's 70 falls below it.
The reproduced range is wider and shifted lower. That is the stochastic variance
this measurement was always reported as having — request latency was materially
higher on the reproduction host state (avg 1005–1724 ms against 736–946 ms), and
slower handling changes how attempts interleave. The gate asks whether the race
reproduces non-zero with the load landing, not whether it lands on the same
integer. It does, three times out of three.

### Integration review — Phase 0 / 1 / 2

Read-only, at `2c028b6` against `main` @ `12be6e7`. Fast-forwardable; `main`,
`d184b54` and `9d03329` all remain ancestors; no history rewritten; branch not
pushed.

- **32 Phase 0/1 source and control files verified byte-identical to `main`** —
  every Phase 1 route and service, both middleware, all of `db/` and `seed/`,
  `001_init.sql`, `index.js`, and every control file including `render.yaml`,
  `package*.json`, `PLAN.md`, `BACKLOG.md`, `CLAUDE.md` and `README.md`.
- **`/` and `/health` frozen contract intact**; `render.yaml` `healthCheckPath`
  unchanged.
- **Error contract intact** — six `HttpError` throws, no ad-hoc error responses,
  one new code (`SEATS_UNAVAILABLE`).
- **Config boundary intact** — `config/env.js` reads exactly the seven variables
  `.env.example` declares, and no `process.env` access exists anywhere else.
- **`availabilityService` untouched and still the only seat-status read**;
  `bookingService`'s only `booking_seats` statements are inserts. Phase 4.3's
  Redis extension point is undisturbed.
- **`seats` remains the authority** — the layout JSON is never consulted on the
  booking path.
- **Naive path byte-identical to `3aaf36b`** and still reachable; transaction
  machinery exists only inside `createBookingSafe`.
- **No forbidden construct is used.** `ON CONFLICT`, `FOR UPDATE` and
  `WHERE NOT EXISTS` appear exactly three times in the repository — all inside
  the comment that forbids them.
- **No Phase 3+ leakage**; no `client/`; dependencies unchanged at six.
- **Zero new dependencies**, zero manifest changes.
- **Git hygiene** — seven commits, one author, no AI attribution, no tracked
  secrets, clean tree.

### Security incident — a live token in a result artifact

The Module 2.3 pre-commit secret scan found **three valid HS256 bearer tokens**
inside the result file. k6 embeds whatever `setup()` returned under
`setup_data`, and `setup()` returns the auth token, so every recorded run
carried a working seven-day credential for the demo user.

Caught before staging. Nothing was committed and the branch has never been
pushed, so no credential left the machine — verified by scanning every commit's
diff and every reachable tree: **zero JWT-shaped strings**. No history rewrite
and no secret rotation were required.

Fixed at two levels: the artifact's three token values were replaced with a
placeholder, with every metric, counter, duration, database count, derived
result and timestamp byte-compared before and after to prove no measurement
moved; and `handleSummary` now strips the token before writing (`2bcba13`), so
future artifacts cannot contain one. The redaction is documented inside the
artifact rather than applied silently.

**Residual risk, open:** the fix guards the `SUMMARY_OUT` path only. k6's
`--summary-export` flag bypasses `handleSummary` entirely and would still write
a live token. The script cannot defend against it — the only in-script
alternative changes the authentication behaviour under measurement. The
mitigation is documentation. See the deferred findings below.

### Deviations from the approved plan

```
Plan says: 2.2 declares no thresholds at all.
Actual:    two always-true, non-aborting thresholds on tagged sub-metrics.
Why:       declaring them is k6's documented way to surface a tagged
           sub-metric in the summary, which keeps setup()'s two requests out
           of the reported booking latency. Neither can abort a run.
```

```
Plan says: k6's default expected statuses.
Actual:    expected statuses set to 200, 201 and 409.
Why:       a 409 is a correct response. Left at the default, http_req_failed
           would read ~100% and could no longer answer the one question it is
           there for — did the load land.
```

```
Plan says: 2.3 and 2.5 record one run each.
Actual:    three runs each, reported as a range with the run count stated.
Why:       the before-number is stochastic (303, 150, 303). A single figure
           from a stochastic process is a sample presented as a constant.
           Approved before 2.3 ran.
```

```
Plan says: §14 creates showrush_baseline and runs `npm run migrate` with 002
           removed from the migrations directory.
Actual:    001_init.sql applied directly via psql to a disposable database;
           the migrations directory is never touched. The close-out
           reproduction used showrush_repro so the 2.3 evidence database
           survived.
Why:       taking a measurement should never require moving a tracked file out
           of the repository. loadtest/README.md is authoritative — see the
           note in §14.
```

```
Plan says: 2.1 modifies lib/validate.js to add seatIdList().
Actual:    also added idValue() and MAX_SEATS_PER_BOOKING.
Why:       show_id needs the same presence check, and seatIdList is built on
           it. Same file, same purpose.
```

```
Plan says: the safe path returns 501 until 2.4 (D3/Q2).
Actual:    true through 2.1–2.3; 2.4 implemented it and no path returns 501.
Why:       as sequenced. Recorded because §4's endpoint table still shows the
           501, now marked superseded.
```

### Deferred findings

Recorded, not silently fixed. None blocks the merge.

**Medium**

- `--summary-export` bypasses `handleSummary` and would write a live bearer
  token into any file it produces. Only `SUMMARY_OUT` is protected. The fix is
  a warning line in `loadtest/README.md` telling operators to use `SUMMARY_OUT`;
  it was not added because it falls outside the authorised scope of the
  corrective commit. **Open.**
- **H1, carried from Phase 1** — `JWT_SECRET` is still not declared in
  `render.yaml`, and the service has `blueprint_sync` history. Phase 2 does not
  compound it: `BOOKING_MODE` is deliberately absent from `render.yaml` too
  (decision D2) and defaults to `safe`, so a stripped variable cannot enable the
  racy path in production. **Open.**

**Low**

- `recordIsolation()`'s memoisation is racy: the guard is read before it is set,
  so under concurrent first bookings the isolation level is queried and logged
  many times rather than once — 92 occurrences observed during 2.5, 31 during
  the close-out reproduction. Log noise, not a correctness problem; the value is
  identical every time. Fix by guarding with an in-flight promise.
- `booking_seats_show_id_seat_id_idx` (Phase 1.2) is now redundant against the
  constraint's own unique index. Deliberately not dropped — index changes are
  Phase 7.3b and approval-gated. Stated in `002` itself.
- No endpoint returns a user's bookings, so a booking can be created but only
  read back through the seat map. Phase 5 needs `booking_ref` lookup anyway.
- `show_prices` coverage is still unenforced at the schema level. Phase 2 fails
  closed in application code (D6); the missing constraint remains deferred.
- The peak-concurrent-backends observation recorded for 2.3 was not captured for
  2.5. It was labelled an observation in both, and no claim depends on it.
- Carried from Phase 1 and unchanged: `bookings.updated_at` has no trigger and
  no writer until Phase 5; `isId` is still imported from `catalogService` rather
  than a shared `lib/ids.js`; services do not guard a null `pool`; seeded day-0
  shows can be in the past; no CORS until Phase 3.1; the `pg` `sslmode=require`
  deprecation warning.

**Resolved by this phase**

- Phase 1 **R2** — `booking_seats.show_id` disagreeing with `bookings.show_id`
  is now impossible on the safe path: both are written from one resolved value
  inside one transaction.

### Local state left behind

The development database `showrush` is deliberately still at `001` only, so the
naive baseline stays reproducible in place rather than solely via §14. A
developer who runs `npm run migrate` will apply `002` — expected, not a defect.
Disposable databases `showrush_25`, `showrush_baseline` and `showrush_repro`
still exist and may be dropped at any time.

### Known limitations carried forward

No seat holds until Phase 4 · no payment, so bookings stay `pending` forever ·
no booking read endpoints · no cancellation · no rate limiting on booking
creation · no automated test suite · single instance, free tier · every number
in this phase measured locally, never against the deployed service.

### Git state

| Ref | Commit |
|---|---|
| `feat/booking-core` (local only, not pushed) | `2c028b6` |
| `main` / `origin/main` | `12be6e7` — untouched |
| `feat/foundation` | `d184b54` — untouched |

Working tree clean. All seven commits authored and committed by
`vivek <vivekrole6110@gmail.com>`, matching every earlier commit in the
repository. No AI attribution anywhere. `.env` untracked; no secrets in any
tracked file on any ref.

### Remaining close-out gates

| # | Gate | Status |
|---|---|---|
| 1 | §14 before-number reproduction | **PASS** |
| 2 | Phase 0/1/2 integration review | **PASS** |
| 3 | `README.md` benchmark table | **NOT DONE** — separately authorized commit |
| 4 | This close-out documentation | **PASS** |
| 5 | `002` applied to Neon | **REQUIRES AUTHORIZATION** — Q7, stop-and-ask before any destructive step |
| 6 | Render `BOOKING_MODE` verification | **NOT DONE** — read-only check that the variable is unset, so production runs `safe` |
| 7 | Merge, deploy and production verification | **NOT DONE** — gated behind 3, 5 and 6 |

### Handed to Phase 3

A working, authenticated `POST /api/bookings` returning the seat list and price
breakdown a booking summary needs; the `{error:{code,message}}` contract with
`SEATS_UNAVAILABLE` for a lost seat; `availabilityService` still the single
seat-status path, ready for Phase 4 to union Redis into; and a booking guarantee
that lives in the database rather than in application code.

**Frozen by this phase:** `UNIQUE (show_id, seat_id)` is the guarantee — the
availability pre-check is UX and may be removed without affecting correctness;
`BOOKING_MODE=naive` is permanent and must never be hardened, removed, or
allowed to run in production.
