# Architecture decisions

Six decisions that shape this system, each with the two alternatives it was
chosen over. `PLAN.md` 8.2 names this file as the canonical list, and
`BACKLOG.md` P1 points here rather than repeating it.

**How to read the evidence.** Every number below was measured on one developer
machine — WSL2, 4 cores, Node v22.23.2, k6 v2.2.0, PostgreSQL 17.11 and Redis
7.4.10 in Docker, a single Node process, `RECONCILE_INTERVAL_SECONDS=0` — and is
quoted as *measured in this benchmark*, never as a capacity or a guarantee. The
raw summaries are in [`loadtest/results/`](../loadtest/results/) and the full
method is in [`docs/phases/phase-7-benchmarks.md`](phases/phase-7-benchmarks.md).

**Where a reason is not documented, this file says so** rather than inventing
one after the fact. Decision 3 is the clearest case.

---

## 1. Booking concurrency — a `UNIQUE` constraint, not application locking

### Decision
`UNIQUE (show_id, seat_id)` on `booking_seats`
([`002_unique_booking_seats.sql`](../server/migrations/002_unique_booking_seats.sql)),
with the multi-seat insert wrapped in one transaction and `23505` translated
into a clean `409 SEATS_UNAVAILABLE`.

### Why it was chosen
Under `READ COMMITTED` — asserted at runtime by `bookingService.js`, not assumed
— a plain `SELECT` takes no locks and neither transaction sees the other's
uncommitted `INSERT`. Two concurrent bookings for the same seat both pass their
availability check and both write. The database is the only participant that
sees every transaction, so it is the only one that can decide. The constraint is
the guarantee; the availability pre-check is convenience, and deleting it leaves
the system correct but ruder.

### How it works here
`createBookingSafe` opens a transaction, inserts the booking, sorts the seat ids
**ascending** so two overlapping transactions take index entries in the same
order and one waits instead of the two deadlocking, then inserts all seats in a
single statement. On `23505` it classifies **by constraint name** —
`booking_seats_show_id_seat_id_key` is a seat conflict, `bookings_booking_ref_key`
is a reference collision worth one retry — and rolls back. The transaction is
what makes a multi-seat booking all-or-nothing; the constraint is what makes each
seat sell once.

The racy predecessor survives permanently behind `BOOKING_MODE=naive`
(`config/env.js`, refused under `NODE_ENV=production`) so the "before" number
stays reproducible. It is a protected defect under `CLAUDE.md` §10, not an
oversight.

### Rejected: `SELECT … FOR UPDATE`
Row locks would work, but the row that needs locking does not exist yet. A seat
being booked has **no** `booking_seats` row to lock, so `FOR UPDATE` would have
to target a proxy — the `seats` row, or the `shows` row — and turn every booking
for a show into a queue behind that proxy, serialising unrelated seats. It also
puts correctness back in application code: forget the clause on one code path and
the guarantee is gone silently, with no error to notice. The constraint cannot be
forgotten by a caller. (`FOR UPDATE` *is* used in this codebase where a row does
exist and a state machine needs protecting: `paymentService.recordPayment` and
the reconciliation sweep both take it on the `bookings` row —
[phase-6 §6.2](phases/phase-6-reconciliation.md). Different problem, different
tool.)

### Rejected: PostgreSQL advisory locks
`pg_advisory_xact_lock(hashtext(...))` would serialise on a derived key rather
than on data. Three costs decided it: the lock key is a hash, so collisions
serialise unrelated seats invisibly; the protection lives entirely in the
application, so any path that forgets to take the lock bypasses it without
error; and the guarantee becomes untestable at the database level — you cannot
point at a schema object and say *this* is what makes a seat sell once. A
constraint is visible in `\d booking_seats`, survives every code path including
`psql`, and needs no cooperation.

### Evidence
Measured in this benchmark, 500 VUs on one seat, three runs each side, re-seeded
between runs:

| | Before — `BOOKING_MODE=naive`, schema `001` | After — `safe`, with `002` |
|---|---|---|
| **Seats sold twice** | **379 · 305 · 379** | **0 · 0 · 0** |
| Bookings created | 380 · 306 · 380 | 1 · 1 · 1 |
| Refused `409` | 120 · 194 · 120 | 499 · 499 · 499 |
| dropped iterations · 5xx | 0 · 0 | 0 · 0 |

An earlier, independent Phase 2 measurement on a different commit recorded
**303 · 150 · 303** double-bookings. The two sets are never merged into one
range. A third run separates the two things that changed: `naive` against a
database that **already has** the constraint produced **0 double-bookings** and
**304 responses that were 5xx**, because the naive path never learned to catch
`23505`. The constraint prevents the double-booking; the transactional path is
what turns the refusal into a 409 instead of a 500.

The before-number is a **range, not a point** — a race is stochastic. The
after-number does not vary, and cannot: the constraint either holds or it does
not. Phase 7 also discloses a fourth naive run whose double-booking count was
lost before being read, so the true spread is likely wider than 305–379.

### Limitation / trade-off
The 409 arrives only at commit time, so a losing request does the work of a
booking before being refused. Latency under this workload is queueing, not
throughput: 500 VUs against a `pg` pool of 10 measures the queue, and the p95
figures in `README.md` are labelled as not a capacity result. The constraint also
has no predicate, which forces a design consequence elsewhere — expiring a
booking must *delete* its seat rows (archiving them to `released_booking_seats`)
rather than only setting a status, or the seat would read `available` and still
409.

---

## 2. Seat holds in Redis with a TTL

### Decision
One Redis key per held seat — `hold:{showId}:{seatId}` → `{userId}` — created
with `SET … NX EX 420` in
[`holdService.js`](../server/src/services/holdService.js).

### Why it was chosen
A hold answers a different question from a booking. A booking must be
permanent, transactional and auditable; a hold must **disappear on its own** if
the user closes the tab. Redis expiry gives that for free, with no sweep, no
cron and no cleanup path that can itself fail. `SET NX` is a single atomic
round trip, which is what makes "two tabs cannot hold the same seat" true
without a transaction.

### How it works here
`acquire` is `SET NX EX 420` inside a Lua script, so a caller who already owns
the key can retry after a dropped response instead of being refused by `NX`;
release and extend are **compare-and-delete / compare-and-extend in Lua**, never
`GET` then `DEL`, because between those two round trips a hold can expire and be
re-acquired by somebody else and you would delete a stranger's hold. Multi-seat
holds acquire in sorted seat order and roll back on partial failure; rollback is
best effort and anything it misses expires at the TTL — stated rather than
dressed up as atomicity. `availabilityService.mergeHolds` performs one `MGET`
over exactly the seats Postgres just returned, and **booked wins over held**.

### Rejected: DB-only holds (a `held_until` column or a `holds` table)
It works, and it costs a cleanup path: rows do not expire, so something must
sweep them, and every availability read must then filter on
`held_until > now()`. That puts an expiry predicate into the same query that
answers "is this seat booked", making the hot read heavier and the schema carry
a lifecycle it does not otherwise need. It also puts short-lived, high-churn
writes into the same tables that hold the permanent record — this benchmark
measured ~600 hold/release cycles per second, which is a lot of dead tuples for
rows that were never meant to survive.

### Rejected: no hold layer at all
Cheapest to build, and the system stays *correct* — the constraint alone
guarantees single sale. What it loses is the user-facing property: two people
would both spend the whole checkout on the same seat and one would be refused at
the very end, after entering payment details. The hold does not make the system
safer; it makes the refusal happen at second 0 instead of second 300.

### Evidence
Measured in this benchmark, uncontended by construction (disjoint seat slices,
any 409 invalidates the run), against the 5,000-seat stress show:

| | 50 VUs | 200 VUs |
|---|---|---|
| **holds/sec** | **605.3** | **590.9** |
| hold latency avg · p95 | 45.4 · 58.5 ms | 198.3 · 227.1 ms |
| 409 conflicts · dropped | 0 · 0 | 0 · 0 |

Two runs at 50 VUs minutes apart gave 586.4 and 608.8 holds/sec, so treat ~600/s
as **±4% on this machine**, not a constant. Four times the concurrency produced
no additional throughput and multiplied latency by ~4.4 — the signature of a
queue, not headroom. Phase 4's crash test is the other half of the argument: a
hold was taken, the server was killed with `SIGKILL`, and Redis released the key
by itself at its TTL with no application running (last seen alive at t+404s with
ttl=16, first seen gone at t+434s on a 30-second poll).

### Limitation / trade-off
**A hold guarantees nothing about the sale.** It is an optimisation over the
`UNIQUE` constraint, and if Redis is unavailable the system is still correct —
see decision 6. Holds are a hard dependency of *holds*, not of bookings. The
release path is best effort by design, so an orphaned hold can outlive its
purpose by up to 420 seconds; on a seat that has since been booked this is
harmless, because `booked` wins the merge. Finally, holds are per-process only
in the sense that matters for the UI: see the F-1 note in decision 4.

---

## 3. Hold TTL — 420 seconds

### Decision
`HOLD_TTL_SECONDS = 420` — seven minutes — a fixed constant in
`holdService.js`, deliberately **not** configurable by environment variable.

### Why it was chosen — and what is honestly not documented
**The repository does not record why 420 was chosen over, say, 180 or 900.**
`PLAN.md` 4.1 specifies `EX 420` as an input to the build, and `PLAN.md` 8.2
poses "why 7 minutes and not 3 or 15" as a question to answer rather than a
decision already justified. No phase document contains a derivation, and no
measurement of real checkout duration was ever taken in this project. Inventing
a rationale here would be exactly the kind of retrofitted reasoning this file
exists to avoid.

What the repository *does* establish are the constraints any value must satisfy,
and 420 satisfies them:

- **It must be long enough to complete a checkout**, or the hold defeats itself.
  Nothing here measures how long that actually takes.
- **It must be shorter than `PENDING_BOOKING_TTL_SECONDS`** (default 900), and
  this is enforced, not merely intended: `reconcileService` compares the two at
  **import time** and the server refuses to start if the window is not larger. A
  booking must never expire while its own hold is still alive, which would cancel
  a booking the user is actively working on.
- **It must be short enough that a late payment is a real case.** Phase 4 §13
  records this explicitly: 420 seconds is short enough that `PLAN.md` 6.1's
  late-payment path is reachable, and the TTL is the clock that case is measured
  against.

### How it works here
The client never computes the deadline. `useSeatHolds` seeds its countdown from
the server's `ttl_seconds`, ticks locally between answers, and **re-reads the
real number from `GET /holds/ttl` whenever the tab returns to visibility** —
because a background tab's timers are throttled and a countdown computed against
`Date.now()` would confidently display a hold the server let go of minutes ago.
Expiry clears the selection and refetches the map. A same-owner re-acquire
refreshes the key back to the full window rather than being refused.

### Hold expiry is not booking expiry
Three clocks, deliberately separate:

| Clock | Value | Owner | What running out means |
|---|---|---|---|
| Hold TTL | 420 s | Redis key expiry | the seat goes back on the map; nothing in Postgres changes |
| Pending booking window | `PENDING_BOOKING_TTL_SECONDS`, default 900 s | the reconciliation sweep | the booking is `cancelled` and its seat rows are deleted and archived |
| Payment | none | `payment_events` | a paid booking is permanent regardless of either clock above |

A hold expiring **does not** cancel a booking, and a booking being cancelled does
not depend on a hold. That separation is what lets a payment arrive after the
hold is gone and still be resolved correctly — honoured if the seats are free,
`refund_pending` if they are not.

### Rejected: a much shorter TTL (~3 minutes)
Would recycle abandoned seats faster and reduce the window in which a seat is
held by nobody. Rejected because it raises the probability that a genuine
checkout expires underneath a real user — the failure mode is losing a seat you
were actively paying for, which is far worse than a seat sitting idle for a few
extra minutes. No measurement of checkout duration exists here to justify
cutting it, and shortening it on intuition is how you ship that failure.

### Rejected: a much longer TTL (~15 minutes), or configurable per environment
A longer window makes abandoned seats unavailable for a quarter of an hour,
which on a busy show is the difference between selling out and appearing sold
out. It also collides with the pending-booking window: at 15 minutes the
`PENDING_BOOKING_TTL_SECONDS` default of 900 s is no longer greater than the
hold TTL, and the server refuses to start. Making it configurable was rejected
separately (recorded in phase-4 §rulings, "TTL stayed a fixed 420 with no
`HOLD_TTL_SECONDS` env var"): a value that can differ per environment is a value
that differs between the benchmark and production, and `reconcileService`'s
start-up assertion depends on knowing it.

### Evidence
The crash test in decision 2 is the only direct measurement of the TTL:
released by Redis at ≈t+420s with no application running. Everything else in
this decision is a constraint, not a measurement.

### Limitation / trade-off
The number is a judgement call, and this document does not pretend otherwise.
The right way to set it is to measure real checkout completion times and pick a
percentile; that measurement has not been taken.

---

## 4. Live seat updates over WebSocket

### Decision
One WebSocket room per show, `GET /ws?show_id=<id>`, **server to client only**
([`realtime/hub.js`](../server/src/realtime/hub.js)).

### Why it was chosen
Seat status is the rare case where the update is genuinely bidirectional in
*interest* even if not in transport: many viewers, changes arriving at
unpredictable times, and a payload small enough that latency dominates cost.
A socket also gives an unambiguous connection lifecycle — when it drops, the
client knows it missed events and can recover by re-reading the REST map, which
is what `useSeatEvents` does on reconnect.

### How it works here
The show is fixed at upgrade time from the query string, so the socket accepts
no client frames at all: there is no join protocol, no subscribe message, and
nothing for a connected socket to ask for. Unknown shows are refused at upgrade
with the same 404 the seat map gives. Rooms are public to anyone holding the show
id, matching the already-public seat map. A 30-second ping/pong reaps half-open
sockets, and an empty room is deleted rather than kept.

What travels over it comes from `availabilityService.getSeatStatusFor` and
nowhere else — the same merge the REST path uses, scoped to the seats that
changed. The tempting shortcut, "a hold was released, so broadcast
`available`", is wrong the moment the seat is also booked, and would be the
second seat-status path `CLAUDE.md` §10 exists to prevent. `broadcastSeats` is
called after the write, never awaited, and returns immediately when nobody is
watching.

### Viewer-agnostic broadcast, viewer-aware REST
These two are deliberately different, and the difference is load-bearing:

- **REST `GET /api/shows/:id/seatmap` is viewer-aware.** `optionalAuth` passes
  the caller's id into the merge, and their own holds are reported back to them
  as `available` — a hold exists so its owner can book those seats, and calling
  it unavailable to them would block the very thing it was taken for.
- **The broadcast is viewer-agnostic.** One read answers the whole room, so a
  hold reads `held` to everybody including its owner. Making it viewer-aware
  would mean one query and one message **per socket** instead of one per change.

The client reconciles the difference by ignoring `held` for seats it holds
itself. That guard is scoped to **one tab's** holds while the server's exemption
is scoped to **an account** — which is finding **F-1**: a hold owned by your
account but taken by another client (a second tab, another device) renders dark
until you reload. Diagnosed in Phase 8 with a deterministic reproduction; low
severity and self-correcting, and the owner can still re-take the seat because a
same-owner re-acquire refreshes the key. **It is not a WebSocket/HTTP delivery
race** — that hypothesis was tested directly and disproved, with 0 of 25 frames
arriving before their HTTP response.

### Rejected: Server-Sent Events
SSE would fit the traffic shape well — this stream *is* one-directional, which
is SSE's whole premise — and it needs no upgrade handshake. It was rejected on
two grounds. First, the broadcast cost measured below is a property of the
*read*, not the transport: SSE would pay exactly the same scoped query and
`MGET` per change, so it buys nothing on the expensive side. Second, the
reconnect story is worse in the one place it matters: browsers auto-reconnect
`EventSource` transparently, which sounds like an advantage but hides the gap
from the application, and this client's correctness depends on **noticing** that
it was disconnected so it can refetch the map. A silent reconnect is a silently
stale seat map.

### Rejected: polling
Simplest possible option, no new protocol, and it degrades gracefully. Rejected
because the cost lands on the wrong side: every polling client pays the *full*
`getSeatStatus` — a whole-show query plus an `MGET` whose width is the seat
count — on every interval whether or not anything changed. Measured in this
benchmark, that read costs **7.5 ms avg / 9.4 ms p95** on the 160-seat show and
**18.5 ms avg / 24.1 ms p95** on the 5,000-seat show. At a 2-second interval,
one hundred idle viewers would run 50 full seat-map queries per second to
discover nothing had changed, whereas the hub runs a **scoped** query only when
a seat actually changes and returns immediately when the room is empty.

### Evidence — the trade-off, measured
Broadcasting is not free, and the number is the honest part of this decision.
Identical hold workload, watchers varied, measured in this benchmark:

| Watchers | holds/sec | vs 0 watchers | hold latency avg |
|---|---|---|---|
| 0 | **499.5** | — | 54.6 ms |
| 1 | **373.4** | **−25.2%** | 75.8 ms |
| 50 | **237.8** | **−52.4%** | 117.4 ms |

**One connected watcher costs a quarter of hold throughput** in this benchmark.
That is the scoped query plus the Redis `MGET`, paid once per seat change
regardless of room size; the further drop at 50 watchers is per-socket fan-out.
The hub's early return when a room is empty is doing substantial work, and
Phase 7 records this as a **measured architectural trade-off, not a defect**.

Socket memory was also measured: RSS sampled at 100, 500 and 1,000 sockets
through connect, churn, disconnect and +180 s showed **no growth observed**,
settling around **96 MB**. Per-socket cost was **not isolable** — GC noise
exceeds it at this scale — so no per-socket figure is given.

Client-side batching is real but **unquantified as a ratio**: both halves
delivered every message with zero loss (4,978 and 4,772 broadcasts, all
received), `immediate` performed exactly one flush per message, and `batched`
collapsed 4,772 messages into 14 flushes. The rAF cadence those flushes were
taken against could not be established — 24.1 Hz idle against a 59 Hz panel — so
**no flush ratio is published anywhere in this repository**.

### Limitation / trade-off
**Single instance only.** A second Node process would broadcast to its own
sockets and nobody else's; Redis pub/sub fan-out is `BACKLOG.md` P2 and is a
stated limitation, not a surprise. Hold *expiry* is never broadcast — a key
disappearing in Redis fires no application event, and a sweep that scanned for
them would be the second seat-status path. A viewer therefore sees an expired
seat return only on their next refetch. And per F-1 above, the client-side guard
is per-tab, not per-account.

---

## 5. PostgreSQL for this workload

### Decision
PostgreSQL, accessed with the `pg` driver and raw SQL — no ORM. Recorded in
[phase-0 §9 D3](phases/phase-0-setup.md).

### Why it was chosen
The entire correctness argument of this project is one line of DDL. A booking
system's central requirement is *this seat sells exactly once*, which is a
uniqueness constraint over a compound key, enforced by the storage engine under
concurrency. Postgres does that natively, in one line, visible in the schema. The
idempotency layer is the same shape again: `payment_events.event_id` is unique,
and that constraint — not application logic — is what makes a replayed payment a
no-op.

Raw SQL rather than an ORM follows from the same argument: Phase 2 turns on
precise control of the transaction and on catching `23505` **by constraint
name**, which is exactly the mechanism an ORM abstracts away. Phase 0 records
`postgres.js` as the alternative driver considered.

### How it works here
Two constraints carry the system:

```sql
alter table booking_seats
  add constraint booking_seats_show_id_seat_id_key unique (show_id, seat_id);

constraint payment_events_event_id_key unique (event_id)
```

Around them: one transaction per booking for all-or-nothing multi-seat inserts,
`SELECT … FOR UPDATE` on the `bookings` row where a state machine genuinely
needs serialising (payment vs sweep), foreign keys to `seats` so **the `seats`
table is the authority on which seats exist** while the layout JSON stays pure
presentation, and integer paise for money — never floats.

### Rejected: MongoDB
**Stated honestly: no comparative evaluation of MongoDB was performed in this
project.** What can be argued from the repository is the requirement it would
have to meet. A unique index on `{show_id, seat_id}` would give single-document
uniqueness, so the headline race is addressable — but a booking here is not one
document: it is a `bookings` row plus N `booking_seats` rows that must succeed or
fail together, plus a `payment_events` row written in the same transaction as the
status change. That is multi-document atomicity, which Mongo can do with
transactions on a replica set, at which point the argument for choosing it over a
relational engine largely evaporates. Cancellation also *deletes and archives*
seat rows to keep the unconditional unique index honest, and reconciliation reads
across `bookings`, `booking_seats` and `released_booking_seats` — joins over
normalised entities are the shape of every read in this system, which is what
Postgres is for.

### Rejected: SQLite
A real candidate for a single-instance application with this data volume: no
container to run, no connection pool, and the same `UNIQUE` constraint semantics,
so the central guarantee would hold. Rejected on the concurrency model. This
system is benchmarked with 500 concurrent writers against one seat; SQLite
serialises writers with a database-level write lock, so the Phase 2 measurement
would be measuring the lock rather than the isolation behaviour it was designed
to expose — and `READ COMMITTED`, the condition under which the naive race is
demonstrated at all, is not what SQLite provides. The hosted target (Neon) and
`docker compose` parity between local and deployed environments settled the rest.

### Evidence
Measured in this benchmark: **0 · 0 · 0** double-bookings with the constraint,
against **379 · 305 · 379** without it, at 500 concurrent VUs on one seat. And on
the payments side, **exactly 1 booking from 10,000 concurrent replays** of a
single payment event (500 VUs × 20 iterations): 1 × `201`, 9,999 × `200`
duplicate, zero 409s, zero 5xx, zero dropped iterations, and exactly **one**
`payment_events` row for the event. Both are database constraints doing the work.

Availability reads scale well in this benchmark: **31× the seats costs ~2.5× the
latency** (7.5 ms avg at 160 seats, 18.5 ms at 5,000).

### Limitation / trade-off
The `pg` pool is left at its default: `db/pool.js` sets no `max`, so **10**
connections. Sampled during a 200-VU hold load, `pg_stat_activity` showed exactly
10 connections at every sample while Postgres itself allows `max_connections=100`
— and throughput was flat from 50 to 200 VUs while latency scaled ~4.4×. The
queue is in Node, not in Postgres. This is reported and deliberately **not**
changed: pool sizing is architecture and is approval-gated. `booking_seats` also
still carries two indexes over identical columns (the Phase 1.2 non-unique index
and Phase 2.4's unique one), both maintained on every insert; dropping the
redundant one is a schema change and is likewise deferred.

---

## 6. What happens when Redis is unavailable

### Decision
**Holds fail closed; bookings, the seat map and live updates keep working.** A
hold attempt returns `503 HOLDS_UNAVAILABLE`, `/health` reports `degraded`, and
the availability read degrades to Postgres-only rather than failing.

### Why it was chosen
Because the guarantee and the optimisation live in different stores. Redis holds
nothing that a seat's correctness depends on — the `UNIQUE` constraint is what
makes a seat sell once — so an outage in Redis must not be able to stop a sale.
Conversely a hold that cannot be *recorded* must not be reported as taken, or two
users would each believe they had a seven-minute window on the same seat.

### How it works here
Two different postures, on purpose, in
[`holdService.js`](../server/src/services/holdService.js) and
[`availabilityService.js`](../server/src/services/availabilityService.js):

- **The write path fails closed.** Every hold script runs through a readiness
  check that raises `503 HOLDS_UNAVAILABLE` ("Seat holds are temporarily
  unavailable") inside `holdService` itself rather than in the route, so no
  caller can bypass it; the client turns that code into "Seat holds are
  unavailable at the moment."
- **The read path degrades open.** `mergeHolds` checks `redis?.isReady`, logs
  `availability: Redis unavailable, seat holds not merged`, and returns the
  Postgres answer unmerged. A seat map that renders without hold shading is far
  better than no seat map, and holds were never the guarantee.

Because the broadcast reads through the same merge, live updates continue during
a Redis outage — they simply stop carrying `held`.

### Rejected: fall back to holds stored in Postgres
The obvious "keep the feature alive" option: on Redis failure, write holds to a
table instead. Rejected because it means **two sources of truth for whether a
seat is held**, and the moment Redis returns you have to reconcile them —
including holds that exist in one store and not the other, with different
expiry semantics (a TTL that Redis enforces itself versus a timestamp column that
something must sweep). `CLAUDE.md` §10 makes `availabilityService` the single
seat-status path precisely to prevent this, and a fallback that only ever runs
during an incident is a code path that is never exercised until the worst
possible moment. Losing holds for the duration of an outage is a smaller cost
than a second hold store.

### Rejected: fail open — allow "holds" without Redis
Let the hold endpoint return `201` and simply not record anything, so checkout
keeps flowing. Rejected outright: it reports a guarantee that does not exist. Two
users would both be told the seat is theirs for seven minutes, both would reach
payment, and one would be refused at commit by the constraint — which is the
exact user-facing failure the hold layer was built to prevent, now made *more*
likely and less explicable. Correctness would survive; trust would not.

### Evidence
Measured in Phase 6 §7 with `showrush-redis` stopped, not speculated:

| Observation | Result |
|---|---|
| `/health` | **`degraded`**, HTTP 503, `redis: error` |
| `POST /holds` | **503 `HOLDS_UNAVAILABLE`** — failing closed as designed |
| `POST /bookings` | **succeeded**, and **still broadcast** — observed on a connected socket, seat status `booked` |
| After restarting the container | `/health` returned to `ok` **without restarting the server** |

Live updates therefore do not depend on Redis; seat *holds* do, and
`BACKLOG.md` already records Redis as a hard dependency of holds.

### Limitation / trade-off
During an outage the seat map cannot show `held` at all, so two users can select
the same seat and one will lose it at booking time with a `409` — the pre-hold
behaviour, which is correct but unfriendly. The degraded read is also silent to
the user: it is logged server-side, and nothing in the UI says "hold information
is currently unavailable". Recovery is automatic but not instantaneous — it
depends on the Redis client reconnecting, and no bound on that has been measured.

---

## What this document does not claim

- **No number here is a capacity or a guarantee.** Every measurement was taken on
  one 4-core WSL2 laptop against local Docker containers, single-instance, with
  the `pg` pool at 10. Other hardware would produce different absolute numbers;
  the before/after ratios are the transferable part.
- **The client-side flush ratio is unresolved**, and no value for it appears in
  this repository.
- **F-1 is explained, not fixed** — and the WebSocket/HTTP race originally
  proposed for it is disproved, not merely unproven.
- **The authenticated availability path is unmeasured.** Every latency figure
  above is anonymous; a signed-in viewer gets a different merge.
- **Nothing here has been measured multi-instance**, and the WebSocket hub does
  not fan out across processes.
- Where the repository does not record a reason — decision 3's specific TTL value
  — this document says so instead of supplying one.
