# show-rush

Concurrent seat reservation system — the booking path for a cinema, built to be
correct under contention rather than merely functional.

**Status:** Phases 0–7 complete on `feat/benchmarks`. Browse movies and shows,
open a seat map, hold up to six seats in Redis for seven minutes, book them
behind a unique constraint that makes a seat sell exactly once, pay through a
mock provider whose idempotency layer survives 10,000 concurrent replays of one
event, watch other people's seats change live over a WebSocket, and have a
reconciliation sweep clean up what nobody finished. Every measured number below
carries the command, machine and commit that produced it.

**What is deployed is not this.** `main` and `origin/main` are still at the
Phase 2 merge (`692ffcf`); Phases 3–7 are nine unmerged commits on
`feat/benchmarks`. The deployed API therefore serves the Phase 2 codebase — no
holds, no payments, no live updates — and **the React client is not deployed at
all**. Merging and deploying are separate decisions that have not been taken.

## Demo

![The seat map: canvas renderer, three price tiers, booked seats dimmed, aisles
after columns 4 and 12.](docs/images/seat-map.jpg)

*Show 1 on the seeded dataset, served by `vite preview` against a local API —
the canvas renderer at `VITE_SEAT_RENDERER=canvas`. Captured 2026-08-31 from the
production client build; it is a screenshot of the local stack, not of the
deployed link below, which still serves Phase 2 and has no client.*

<https://show-rush.onrender.com>

**Demo account** — no need to register:

```
demo@show-rush.dev
demo-password
```

**What that link actually serves.** It runs `main`, which is the Phase 2
codebase. The four endpoints below are all of it. Holds (Phase 4), payments
(Phase 5), the reconciliation sweep and the WebSocket (Phase 6) and the React
client (Phase 3) are **not deployed** — they exist only on `feat/benchmarks`.
To see the whole system, run it locally as described under
[Local setup](#local-setup).

```bash
curl https://show-rush.onrender.com/health
curl https://show-rush.onrender.com/api/movies
curl https://show-rush.onrender.com/api/movies/1/shows
curl https://show-rush.onrender.com/api/shows/1/seatmap
```

The link and the credentials above were last exercised on **2026-08-18**, when
the cold-start figure below was measured. They have not been re-tested since,
and nothing in Phase 8 re-tested them.

**Cold start: 23.2–27.0 seconds.** The free tier sleeps after ~15 minutes idle,
so the first request after a quiet period is slow. Subsequent requests are
sub-second.

This is a **deployment characteristic of the free tier, not a performance
benchmark of the system.** It measures how long Render takes to wake a sleeping
container, and says nothing about how the booking path behaves under load.
Those numbers are in [Benchmarks](#benchmarks) below.

<details>
<summary>How the cold start was measured</summary>

3 samples, each after 16 minutes of enforced idle time, taken 2026-08-18:

| Sample | Time | Result |
|---|---|---|
| 1 | 24.418s | HTTP 200 `{"status":"ok","db":"ok","redis":"ok"}` |
| 2 | 23.163s | HTTP 200 `{"status":"ok","db":"ok","redis":"ok"}` |
| 3 | 27.006s | HTTP 200 `{"status":"ok","db":"ok","redis":"ok"}` |

```
curl -s -o /dev/null -m 300 -w '%{time_total} %{http_code}' \
  https://show-rush.onrender.com/health
```

Render free tier, Singapore, against Neon PostgreSQL 17 and Upstash Redis, both
Singapore. Wall-clock from a residential connection in India, so it includes
network latency as well as container spin-up — the two are not separated here.

</details>

## Architecture

```mermaid
flowchart LR
    B["React client<br/>Vite"]
    subgraph N["Node — single process"]
        API["Express API<br/>routes and services"]
        WS["WebSocket hub<br/>one room per show"]
        SW["reconcile sweep<br/>in-process interval"]
    end
    AV["availabilityService<br/>the only seat-status answer"]
    PG[("PostgreSQL 17<br/>UNIQUE show_id, seat_id<br/>payment_events.event_id")]
    RD[("Redis 7<br/>hold key per seat<br/>SET NX EX 420")]

    B -- "REST, session cookie" --> API
    WS -- "seat status frames" --> B
    API --> AV
    SW --> AV
    AV -- "booked?" --> PG
    AV -- "held?" --> RD
    API -- "bookings, payments" --> PG
    API -- "holds" --> RD
    API -- "after the write" --> WS
    WS --> AV
```

Read it in one sentence: **Postgres is the guarantee, Redis is the
optimisation, and `availabilityService` is the only code that merges the two.**
A hold stops two people spending seven minutes on the same seat; it is the
`UNIQUE (show_id, seat_id)` constraint, not the hold, that makes a seat sell
exactly once. Everything the WebSocket says comes from that same merge — never
inferred from whichever action triggered the broadcast.

## Prerequisites

- Node **v22.23.2** — `nvm use` reads `.nvmrc`
- Docker (Docker Desktop with WSL integration, or a native daemon)
- k6 — needed only to re-run the load tests in [`loadtest/`](loadtest/)

## Local setup

```bash
nvm use
npm ci

cp .env.example .env      # then fill in the values below
docker compose up -d      # local Postgres and Redis
```

`.env` is the single source of truth for configuration. Every variable it lists
is required; the server refuses to start without `JWT_SECRET`.

| Variable | Local value |
|---|---|
| `NODE_ENV` | `development` |
| `PORT` | `3000` |
| `DATABASE_URL` | `postgres://showrush:showrush@localhost:5433/showrush` |
| `REDIS_URL` | `redis://localhost:6380` |
| `JWT_SECRET` | generate one, see below |
| `JWT_EXPIRES_IN` | `7d` |
| `BOOKING_MODE` | `safe` — `naive` only for the baseline measurement below |
| `CLIENT_ORIGIN` | `http://localhost:5173` — the browser client's exact origin, for CORS |

Ports are **5433** and **6380**, not the Postgres and Redis defaults — the
defaults were already taken on the machine this was built on. `docker-compose.yml`
maps them.

Generate a signing secret:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

### Migrate

Applies every unapplied file in `server/migrations/` in filename order, each in
its own transaction, recording what ran in `schema_migrations`. Re-running is
safe and does nothing.

```bash
npm run migrate
```

### Seed

1 cinema, 3 screens, 5 movies, 20 shows, 504 seats, tier prices, the demo
account, and a partially-booked seat map.

```bash
npm run seed
```

**The seed truncates first**, so it replaces the data rather than adding to it —
that is what makes it re-runnable. It refuses to run when `NODE_ENV=production`
unless `--force` is passed.

### Seed the stress dataset (optional)

Adds one 5,000-seat screen, `Stadium (stress)`, and a show on it — the dataset
behind the rendering baseline below. It is **additive**: it never truncates, and
re-running it replaces only its own screen, so the demo data is untouched.

```bash
npm run seed:stress     # prints the show id; the map is at /shows/<id>
```

### Run


```bash
npm run dev     # node --watch
npm start
```

Then `curl localhost:3000/health` — expect `{"status":"ok","db":"ok","redis":"ok"}`.

Two variables control the Phase 6 reconciliation sweep, both with working
defaults in `.env.example`:

| Variable | Default | What it does |
|---|---|---|
| `PENDING_BOOKING_TTL_SECONDS` | `900` | how long a booking may sit `pending` before the sweep cancels it and returns its seats. Must exceed the 420 s hold TTL, or the server refuses to start |
| `RECONCILE_INTERVAL_SECONDS` | `60` | how often the in-process sweep runs. **`0` disables it** and leaves `npm run reconcile` working — set that before any benchmark, so a background job cannot change booking status mid-measurement |

```bash
npm run reconcile    # run one sweep now, and exit
```

### The client

```bash
cp client/.env.example client/.env    # VITE_API_BASE_URL=http://localhost:3000
npm run dev:client                    # http://localhost:5173
```

`CLIENT_ORIGIN` in the root `.env` must match the client's origin exactly —
`http://localhost:5173` for `dev:client`, `http://localhost:4173` for
`preview:client`. There is no wildcard: the client sends its session cookie on
every request, and a wildcard origin is not permitted for credentialed requests.

Client variables live in `client/.env`, not the root `.env`, because Vite bakes
them into the bundle at build time. Nothing secret may go in that file —
everything in it ships to the browser.

```bash
npm run build:client      # production bundle into client/dist
npm run preview:client    # serve that bundle on http://localhost:4173
```

Sign in with the demo account above. Selection is client-side and needs no
account; only booking does.

## API surface

Every non-2xx response under `/api` is
`{"error":{"code":"SCREAMING_SNAKE","message":"..."}}`. The code is the stable
part; clients branch on it.

### Health

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | `{"service":"show-rush","status":"ok"}` — Render's health check target |
| `GET` | `/health` | `{"status","db","redis"}` — 200 healthy, 503 degraded |
| `GET` | `/metrics` | p50/p95/p99 for the booking, hold, payment and availability paths. **404 when `NODE_ENV=production`** |

### Observability

Every request produces exactly one structured JSON line:

```json
{"ts":"2026-08-22T17:48:45.467Z","level":"info","instance_id":"m2-final",
 "req_id":"9b994328-e9c2-4559-93f2-4a06e27d6402","method":"GET",
 "route":"/api/movies","status":200,"duration_ms":8.25}
```

`X-Request-Id` is accepted from the caller when it is well-formed and minted
otherwise, and is echoed back on the response so a client can correlate its logs
with the server's. `INSTANCE_ID` labels the process; unset falls back to the pid.

**The route pattern is logged, never the URL** — `/api/shows/:id/seatmap`, not
`/api/shows/13/seatmap`. That keeps the metric cardinality equal to the size of
the routing table rather than the size of the traffic, and it is the only reason
percentiles mean anything. **No body, header, cookie, token, email or query
string is ever logged.**

`GET /metrics` reports count, min, max, mean and p50/p95/p99 per route.
Percentiles are **bucket upper bounds** — the histogram is fixed-bucket so that
memory stays constant under load — while count, min, max and mean are exact. The
response says so itself in `percentile_method`. Metrics are per-process and
reset on restart; this is a benchmarking and debugging surface, not a monitoring
system.

Measured overhead on the hold path: **none detectable**. Three runs with the
middleware mounted and three without differ by 3.3 % of mean throughput against
a ~16 % run-to-run spread, with near-identical ranges. Method, caveats, and why
the control was not run under k6:
[`docs/phases/phase-9-improvements.md`](docs/phases/phase-9-improvements.md).

### Auth

| Method | Path | Body / auth | Success | Errors |
|---|---|---|---|---|
| `POST` | `/api/auth/register` | `{email, password, name}` | `201 {user, token}` | `409 EMAIL_TAKEN`, `400 VALIDATION_ERROR` |
| `POST` | `/api/auth/login` | `{email, password}` | `200 {user, token}` | `401 INVALID_CREDENTIALS` |
| `GET` | `/api/auth/me` | `Authorization: Bearer <token>` | `200 {user}` | `401 UNAUTHENTICATED` |
| `POST` | `/api/auth/logout` | none | `204`, clears the cookie | — |

Tokens are HS256, default lifetime 7 days. Passwords are hashed with bcrypt;
`password_hash` never appears in a response. An unknown email and a wrong
password return the identical 401, so the endpoint cannot be used to enumerate
accounts.

**Two transports, one session.** Register and login return `{user, token}` as
before *and* set an `httpOnly` cookie. `requireAuth` accepts either, and
**Bearer takes precedence**, so `curl`, k6 and every documented example keep
working byte-for-byte. The browser client uses only the cookie and never reads
the token, so no session material is reachable from JavaScript.

Because the deployed client is a different site (`onrender.com` is a public
suffix), the cookie needs `SameSite=None`, which removes the CSRF protection
`SameSite` normally provides. The replacement: cookie-authenticated
**state-changing** requests must also send `X-Requested-With: show-rush`, a
header a cross-site form post cannot set. Missing it returns
`403 CSRF_HEADER_REQUIRED`. Bearer-authenticated requests are exempt — an
`Authorization` header is itself not forgeable cross-site.

### Catalogue and seat map

All public — browsing does not require an account.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/movies` | `[{id, title, description, duration_minutes, language, certificate, poster_url}]` |
| `GET` | `/api/movies/:id/shows` | `{movie, shows: [{id, starts_at, screen: {id, name}}]}` |
| `GET` | `/api/shows/:id/seatmap` | `{show, screen: {id, name, cinema_name, layout}, seats: [...]}` |

Unknown or malformed ids return `404 NOT_FOUND`.

Each seat is `{id, row_label, seat_number, tier, price_paise, status}`, where
`status` is `"available"`, `"held"` or `"booked"`. Prices are integer paise,
never floats.

**This route is viewer-aware.** `optionalAuth` means a signed-in caller's own
holds are reported back to them as `"available"` — a hold exists so its owner
can go on to book those seats, and reporting it to them as unavailable would
block the very thing it was taken for. Everyone else, including anonymous
callers, sees `"held"`. The WebSocket broadcast is deliberately *not*
viewer-aware; see [Live updates](#live-updates) for what that costs.

`screen.layout` is presentation data — rows, columns, tiers, aisle positions.
**The `seats` table is the authority on which seats exist**; the layout only
describes how to draw them.

### Booking

| Method | Path | Body / auth | Success | Errors |
|---|---|---|---|---|
| `POST` | `/api/bookings` | `{show_id, seat_ids}` · `Authorization: Bearer <token>` | `201 {booking}` | `409 SEATS_UNAVAILABLE`, `404 NOT_FOUND`, `400 VALIDATION_ERROR`, `401 UNAUTHENTICATED` |

Up to **6 seats** per booking, enforced server-side. All-or-nothing: if any seat
is taken, the whole request is refused and nothing is written. The booking is
returned as `{booking_ref, show_id, status, total_paise, seats}`. A new booking
is `"pending"`; `POST /api/payments/confirm` is what makes it `"paid"`, and the
reconciliation sweep is what cancels it if nobody does.

A seat held by *somebody else* is not available to book; a seat the caller holds
themselves is, which is what a hold is for.

### Cancellation

| Method | Path | Body / auth | Success | Errors |
|---|---|---|---|---|
| `POST` | `/api/bookings/:ref/cancel` | none · auth | `200 {booking}` | `409 NOT_CANCELLABLE`, `409 CANCELLATION_WINDOW_CLOSED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `401 UNAUTHENTICATED` |

A booking is cancelled **whole** — there is no partial cancellation. `pending`
becomes `cancelled`; `paid` becomes `refund_pending`, and the response carries
`refund_due` so a client does not have to infer it from a status string.

**Nothing is refunded.** There is no payment provider in this build — a real
gateway is `BACKLOG.md` P1 — so `refund_pending` is a record that a refund is
owed, never evidence that one happened.

Cancellation is allowed until `CANCELLATION_WINDOW_MINUTES` (default **120**)
before the show starts, measured against `shows.starts_at` rather than against
when the booking was made. Exactly on the boundary is closed.

**Cancelling deletes the booking's seat rows, it does not only change a status**
— the same reason expiry does. They are archived to `released_booking_seats`
with `reason = 'cancelled'` first, which is what distinguishes a booking the
sweep gave up on from one its owner handed back. The seats are announced to the
show's WebSocket room after the transaction commits.

A cancellation, a payment and the reconciliation sweep for one booking all take
`FOR UPDATE` on the same `bookings` row, so whichever commits first wins outright
and the others read the committed result.

`409 SEATS_UNAVAILABLE` is the same code whether the seat was already gone when
the request arrived or was lost in a race at commit time. A client should not
have to know which layer caught it.

### Holds

A hold is one Redis key per seat, `hold:<show>:<seat>`, taken with
`SET NX EX 420` and released with a compare-and-delete Lua script so a client
can never delete a stranger's hold. Multi-seat holds are all-or-nothing and are
acquired in sorted seat order; rollback of a partial failure is best-effort, and
anything it misses expires at the TTL.

| Method | Path | Body / auth | Success | Errors |
|---|---|---|---|---|
| `POST` | `/api/shows/:id/holds` | `{seat_ids}` · auth | `201 {hold: {show_id, seat_ids, ttl_seconds}}` | `409 SEATS_HELD`, `429 RATE_LIMITED` (with `Retry-After`), `503 HOLDS_UNAVAILABLE`, `404 NOT_FOUND`, `400 VALIDATION_ERROR` |
| `DELETE` | `/api/shows/:id/holds` | `{seat_ids}` · auth | `200 {released: {show_id, seat_ids}}` | `404 NOT_FOUND`, `400 VALIDATION_ERROR` |
| `GET` | `/api/shows/:id/holds/ttl?seat_ids=1,2` | auth | `200 {holds: [{seat_id, ttl_seconds}]}` | `404 NOT_FOUND`, `400 VALIDATION_ERROR` |

`ttl_seconds` is **420** — seven minutes. The countdown in the client is seeded
from this number and never from `Date.now()`.

`409 SEATS_HELD` is deliberately not `SEATS_UNAVAILABLE`: a held seat is
somebody else's seven-minute window, not a sold seat, and a client can sensibly
tell one user to try again shortly and the other not to bother. `DELETE` never
errors on a hold that has already expired — nothing to release is an ordinary
outcome, not a failure.

**Redis down means holds fail closed** with `503 HOLDS_UNAVAILABLE`. Bookings
keep working, because the constraint — not the hold — is the guarantee. Measured
in Phase 6 §7, not assumed.

### Payments

A mock provider, called by the payer's own session rather than by a provider
webhook. A real gateway is `BACKLOG.md` P1; the idempotency layer underneath is
indifferent to which of the two calls it, which is the point of testing it now.

| Method | Path | Body / auth | Success | Errors |
|---|---|---|---|---|
| `POST` | `/api/payments/confirm` | `{booking_ref, payment_event_id, simulate?}` · auth | `201 {payment, booking}` first time · `200` for a replay | `402 PAYMENT_FAILED`, `409 BOOKING_NOT_PENDING`, `409 EVENT_ALREADY_USED`, `404 NOT_FOUND`, `400 VALIDATION_ERROR` |

`payment_events.event_id` is unique, and that constraint — not application
logic — is what makes a replay a no-op. **A duplicate is `200` with the original
booking, never a `409`**, and it performs zero side effects: no charge, no
`UPDATE`, no Redis call. The same event id used against a *different* booking is
`409 EVENT_ALREADY_USED`, because returning the stored answer would disclose
another booking's reference and total.

**Postgres commits first; the Redis hold is released after.** Releasing inside
the transaction would be a correctness bug: a rollback would free the seat while
the payment succeeded. A hold outliving its booking is harmless — the seat is
already sold.

`simulate: {outcome, delay_ms}` drives the mock's success, failure and delay. It
is refused outright in production.

**Late payments resolve in both directions.** If the hold expired and the sweep
cancelled the booking, a payment arriving afterwards is honoured when the seats
are still free, and recorded as `refund_pending` when they are not — one code
path, no new error code, and no double-sell either way.

### Live updates

`GET /ws?show_id=<id>` — a WebSocket upgrade, **server to client only**.

One room per show. The socket accepts no client frames at all: the show is fixed
at upgrade time from the query string, so there is nothing for a connected
socket to ask for. Rooms are public to anyone holding the show id, matching the
already-public seat map. Frames are `{type: "seats", show_id, seats: [{id,
status}], at}`, and a `hello` frame carries the heartbeat interval.

**Broadcasts are viewer-agnostic**: a hold reads `"held"` to everybody,
including the person who took it, and the client is what knows its own holds and
ignores those messages. That single design decision is the whole of finding
**F-1** under [Known limitations](#known-limitations).

## Architecture notes

- **Raw SQL over `pg`**, no ORM. Phase 2 needs precise control of the
  transaction and the constraint-violation catch — the exact mechanism an ORM
  would hide.
- **`availabilityService` is the only code that answers "is this seat taken".**
  One query path: booked in Postgres, unioned with held in Redis by a single
  `MGET` over the seats Postgres just returned. `holdService` owns holds; it
  deliberately exposes no availability read of its own.
- **`UNIQUE (show_id, seat_id)` on `booking_seats` is the guarantee**, added by
  `002_unique_booking_seats.sql`. The availability check in front of it is
  convenience; the database is the only participant that sees every transaction,
  so it is the only one that can decide.
- **Live seat updates are one WebSocket room per show**, `GET /ws?show_id=<id>`,
  server-to-client only. What travels on it comes from `availabilityService` —
  the same single query path — never inferred from the action that triggered it,
  because "a hold was released, so the seat is free" is wrong the moment the seat
  is also booked. Rooms are public to anyone with the show id, matching the
  already-public seat map. Single instance: a second process would broadcast only
  to its own sockets.
- **Expiring a booking deletes its seat rows, it does not only change a status.**
  `UNIQUE (show_id, seat_id)` has no predicate, so a `cancelled` booking that
  kept its rows would leave a seat that reads `available` and still 409s. The
  rows are archived to `released_booking_seats` first, which is also the list a
  late payment re-claims from.
- **The racy path is kept on purpose.** `BOOKING_MODE=naive` is the
  check-then-insert version the constraint replaced. It stays in the codebase
  permanently, because without it the before-number above could never be
  measured again. It refuses to start under `NODE_ENV=production`.

## Benchmarks

### Booking concurrency — 500 users, one seat

500 virtual users try to book the **same seat on the same show at the same
moment**. The question is how many of them walk away holding it.

| | Before — `BOOKING_MODE=naive` | After — `BOOKING_MODE=safe` |
|---|---|---|
| **Seats sold twice** | **303 · 150 · 303** | **0 · 0 · 0** |
| Bookings created (201) | 304 · 151 · 304 | 1 · 1 · 1 |
| Correctly refused (409) | 196 · 349 · 196 | 499 · 499 · 499 |
| Server errors (5xx) | 0 · 0 · 0 | 0 · 0 · 0 |
| Other 4xx · no response | 0 · 0 | 0 · 0 |
| Iterations run | 500 · 500 · 500 | 500 · 500 · 500 |
| **Dropped iterations** | **0 · 0 · 0** | **0 · 0 · 0** |
| `http_req_failed` | 0% · 0% · 0% | 0% · 0% · 0% |

Three runs each side, re-seeded before every run. The before-number is a
**range, not a point**: a race is stochastic, so reporting one figure would be
presenting a sample as a constant. The after-number does not vary, and cannot —
the constraint either holds or it does not.

**The zero is a result, not an absence of load.** All 500 attempts ran and were
answered in every run on both sides: zero dropped iterations, zero 5xx, zero
unanswered requests. A run where the load never landed would also report zero
double-bookings, which is why those rows are here.

#### What changed between the two columns

One migration:

```sql
alter table booking_seats
  add constraint booking_seats_show_id_seat_id_key unique (show_id, seat_id);
```

That constraint is the guarantee. The availability check before it is a
convenience — delete it and the system is still correct, just ruder. Delete the
constraint and no amount of application code makes it safe, because under
`READ COMMITTED` a plain `SELECT` takes no locks and neither transaction sees
the other's uncommitted insert.

A third run separates the two things that changed. `BOOKING_MODE=naive` against
a database that **already has** the constraint: **0 double-bookings**, 1 created,
195 refused, and **304 responses that were 5xx** — because the naive path never
learned to catch `23505`. The database refused every duplicate on its own. The
constraint prevents the double-booking; the transactional path is what turns the
refusal into a clean 409 instead of a 500.

#### Method

| | |
|---|---|
| Script | [`loadtest/seat-contention.js`](loadtest/seat-contention.js), 500 VUs, `per-vu-iterations`, 1 iteration per VU, 3 s start barrier |
| Counted by | [`loadtest/count-double-bookings.sql`](loadtest/count-double-bookings.sql) — `sum(claims − 1)` per `(show_id, seat_id)` over non-cancelled bookings |
| Target | show 1, seat 3, `http://localhost:3000`, fresh seed before every run |
| Database | local Docker **PostgreSQL 17.11** (`postgres:17-alpine`, port 5433) — never Neon, never the deployed service |
| Isolation | **`read committed`**, asserted by the server at runtime, not assumed |
| Connection pool | `pg` default **max 10** — the effective server-side concurrency ceiling, and part of what these numbers measure |
| Machine | Ubuntu 26.04 on WSL2 / Windows 11, 4 cores, 5.8 GiB RAM, Node v22.23.2, k6 v2.2.0 |
| Commit | `a372d09` · measured 2026-08-19 UTC |
| Raw evidence | [`loadtest/results/`](loadtest/results/) — the full k6 summary behind every number |

Both runs were taken with an unrelated local Postgres container stopped, so the
two sides are comparable.

#### Latency is reported, not claimed

| p95 per run | Before | After |
|---|---|---|
| | 1090.4 · 911.9 · 994.6 ms | 1139.5 · 734.9 · 831.9 ms |

**These are not a throughput or capacity result.** 500 virtual users against a
pool of 10 connections measures queueing, and the before/after difference is not
a performance improvement — the two paths do different amounts of work per
request. Nothing here says how many bookings per second this system sustains.
That question is Phase 7's.

#### Reproducing it

**After (safe)** — the current schema:

```bash
npm run migrate && npm run seed
BOOKING_MODE=safe npm start

k6 run loadtest/seat-contention.js
docker exec -i showrush-postgres \
  psql -U showrush -d showrush -f - < loadtest/count-double-bookings.sql
```

**Before (naive)** — needs a database **without** the constraint, so flipping
one environment variable is not enough:

```bash
docker exec showrush-postgres psql -U showrush -d postgres \
  -c "create database showrush_baseline"

# schema 001 only, applied directly — the fix is deliberately absent
docker exec -i showrush-postgres psql -U showrush -d showrush_baseline \
  < server/migrations/001_init.sql

export DATABASE_URL="postgres://showrush:showrush@localhost:5433/showrush_baseline"
npm run seed
BOOKING_MODE=naive npm start

k6 run loadtest/seat-contention.js
docker exec -i showrush-postgres \
  psql -U showrush -d showrush_baseline -f - < loadtest/count-double-bookings.sql
```

The counting SQL prints the `booking_seats` indexes last, so every run carries
proof of which schema produced it. `BOOKING_MODE=naive` refuses to start with
`NODE_ENV=production` — the racy path exists permanently so this measurement
stays reproducible, never to serve anyone.

Full method, deviations, and the variance discussion:
[`docs/phases/phase-2-booking-core.md`](docs/phases/phase-2-booking-core.md) and
[`loadtest/README.md`](loadtest/README.md).

### Seat map rendering — 5,000 seats, DOM

The Phase 3 seat map is a plain DOM grid: one `<button>` per seat, no
memoisation, no virtualisation. These two numbers are the **"before"** for the
canvas renderer in [`BACKLOG.md`](BACKLOG.md) P1. Without them that work would
be unclaimable, which is the only reason they exist.

| Metric | Result |
|---|---|
| **`SeatButton` components re-rendered per seat click** | **5,000 — every seat, in all 10 trials** |
| **Click-to-paint latency** | **median 79.0 ms** · range 33.2–113.4 ms · n=10 |
| React commits per click | 1 (all 10 trials) |
| Fibers receiving new props per commit | 15,629–15,645 |
| DOM nodes on the page | 5,563 |

Clicking one seat re-renders all 5,000. That is what an unmemoised DOM grid
does, and it is deliberate — memoising it now would leave the canvas rewrite
with a strawman to beat. Nothing here is a claim about the backend.

<details>
<summary>How these were measured</summary>

```bash
npm run seed          # demo dataset, untouched by the next line
npm run seed:stress   # adds "Stadium (stress)": 100 rows x 50 = 5,000 seats
                      # prints the show id — the map is at /shows/<id>

PROFILE=1 npm run build:client       # production build, profiling hooks kept
npm run preview:client               # serves the build, never the dev server
```

**Procedure.** 10 trials on 10 distinct available seats spread across the grid
(`A1, C38, F25, I12, K49, N36, Q23, T10, V47, Y34`), one warm-up click
discarded. Each trial: reset selection, `click()` the seat, then measure to the
second `requestAnimationFrame` after the click — i.e. after the frame carrying
the update has been painted. The seat is clicked again to deselect before the
next trial, so every trial starts from an empty selection and none of them hits
the six-seat ceiling.

**How re-renders were counted.** A minimal stand-in for the React DevTools
global hook was installed in the page and `onCommitFiberRoot` walked the fiber
tree on every commit. A component that re-rendered receives a freshly created
props object from its parent, while a subtree React bails out of keeps the
identical reference — so `alternate.memoizedProps !== memoizedProps` counts
exactly the components that rendered, independent of timer resolution.

Counting instead by `actualDuration > 0`, which is the timing-based signal,
reported only 205–424 components. That is a **severe undercount**: at 5,000
components most individual renders fall below the clock's resolution. The
reference comparison is the number reported above; the timing-based figure is
recorded here so the discrepancy is not rediscovered later as a contradiction.

**No application component was modified to measure this.** The profiling build
is enabled by `PROFILE=1` in `client/vite.config.js`; an ordinary
`npm run build:client` produces a byte-identical bundle to one built before that
flag existed (`index-DVXeHI2f.js` in both cases).

| | |
|---|---|
| Machine | Windows 11, 16 logical cores, WSL2 Ubuntu for the server side |
| Browser | Google Chrome 151, viewport 1280x609, devicePixelRatio 1.5 |
| Build | production, `PROFILE=1` (profiling hooks retained), served by `vite preview` |
| React | 19.2.8 · Vite 8.2.2 · Node v22.23.2 |
| Dataset | `npm run seed:stress` — 100 rows x 50 seats = 5,000, one show |
| Samples | 10 trials, median and full range reported |
| Date | 2026-08-21 |
| Commit | Phase 3 (`feat/seat-map`) |

**What these numbers are not.** They are single-point client-side measurements
on one machine, one browser and one viewport. They are not throughput, not
capacity, not a server benchmark, and they say nothing about any other device.
The re-render count is a property of the implementation and does not vary; the
latency figure does, which is why the full range is given rather than a single
figure.

</details>

### Seat map rendering — 5,000 seats, canvas + quadtree

The canvas renderer from [`BACKLOG.md`](BACKLOG.md) P1, measured against the DOM
baseline directly above. Both renderers ship permanently behind
`VITE_SEAT_RENDERER`, defaulting to `canvas` — the DOM grid is the "before", and
it is also the only path a screen reader or keyboard can use.

| Metric | DOM (before) | Canvas (after) |
|---|---|---|
| **Click-to-paint, 5,000 seats** | median **79.0 ms** · 33.2–113.4 · n=10 | median **36.9 ms** · 26.1–41.9 · n=10 |
| **`SeatButton` components re-rendered per click** | **5,000**, all 10 trials | **0 exist** — structural, not a profiler run |
| Shapes drawn at fit view | 5,000 DOM nodes | 5,000 of 5,000 |
| Shapes drawn at scale 1.65 | n/a | **312 of 5,000 (6.2 %)** |
| Quadtree over the layout | n/a | 1,329 nodes, depth 5 |

Same ten seats, same procedure, same viewport and browser as the baseline, on a
production build served by `vite preview`. The canvas figure is its **worst
case**: at the fit view nothing can be culled because everything is on screen.

> **Frame rate while panning is deliberately not quoted here.** The display-rate
> gate passed — 59.7 / 59.5 / 60.0 Hz idle, so unlike the batched-updates
> measurement below these *are* rAF conditions — and pan rates were recorded
> from 8.1 Hz at 5,000 shapes to 40.8 Hz at 288. But the draw loop was then
> changed to batch seats by appearance, and the measuring tab became unavailable
> before that could be re-measured. **No frame-rate claim is made for the
> shipped renderer.** Full detail, including the numbers that were taken:
> [`docs/phases/phase-9-improvements.md`](docs/phases/phase-9-improvements.md).

<details>
<summary>How these were measured</summary>

```bash
npm run seed:stress                 # Stadium (stress): 100 rows x 50 = 5,000
npm run build:client                # production build
npm run preview:client              # served on :4173, never the dev server
```

Ten trials on the same ten seats the baseline used
(`A1, C38, F25, I12, K49, N36, Q23, T10, V47, Y34`), one warm-up discarded, each
measured from the click to the **second `requestAnimationFrame`** after it, with
the selection reset between trials. Every trial selected exactly one seat, which
is also the hit-testing check: ten targets spread across all three aisle regions
and into multi-letter row labels, ten exact hits.

The display-rate gate ran first — three 2-second native `requestAnimationFrame`
probes in the measuring tab — because Phase 7 §5 parked a measurement for
exactly this reason. `window.__srSeatRender` exposes the counters and
`fpsProbe(ms)`.

| | |
|---|---|
| Machine | Windows 11, Intel Core i7-13620H; WSL2 Ubuntu 26.04 for the server |
| Browser | Google Chrome 151, canvas viewport 1248x427, devicePixelRatio 1.5 |
| Build | production, served by `vite preview` on :4173 |
| React | 19.2.8 · Vite 8.2.2 · Node v22.23.2 |
| Dataset | `npm run seed:stress` — 5,000 seats, one show |
| Samples | 10 trials, median and full range reported |
| Date | 2026-08-22 |

**What these are not.** Single-point client-side measurements on one machine,
one browser and one viewport. Not throughput, not capacity, not a server
benchmark. The re-render comparison is structural — it establishes that the
component the baseline counted is absent, not a profiler count of the canvas
path.

</details>

### Live seat updates — batched vs un-batched

Under a sustained broadcast stream, buffering incoming seat updates and applying
them in one flush instead of one-per-message. Both paths ship permanently behind
`VITE_SEAT_UPDATE_MODE`, for the same reason `BOOKING_MODE=naive` survives: a
before-number that cannot be re-run is a claim, not a measurement.

> **Read this before quoting the numbers.** The recorded run was taken in a
> browser tab that stayed **hidden**, and Chrome does not run
> `requestAnimationFrame` in a hidden tab. The flush clock exercised here was the
> hook's **1 s hidden-tab fallback**, not rAF. **These are not rAF numbers**, and
> no rAF figure is estimated anywhere in this repository — the visible-tab
> measurement is still owed. `loadtest/README.md` has the exact commands.

| Metric (per run) | `immediate` | `batched` |
|---|---|---|
| messages received | 4,802 | 4,624 |
| seat updates carried | 9,604 | 9,248 |
| **state flushes** | **4,802** | **11** |
| DOM mutation callbacks | 4,226 | 11 |
| DOM `data-status` writes | 9,604 | 176 |

The two runs produced slightly different loads, so the comparison that matters is
per message: **1,000 flushes per 1,000 messages un-batched, against 2.4 per
1,000 batched.** Attribute writes fell 55×, because coalescing by seat id
collapses repeated changes to the same seat.

**Method.** 15 VUs × 2 seats, hold → 50 ms → release → 50 ms, 20 s, against a
84-seat show, one tab watching. `loadtest/seat-churn.js`, k6 v2.2.0, Node
v22.23.2, Postgres 17.11 and Redis 7.4.10 in Docker, WSL2 on 4 cores. Browser
counters from `window.__srSeatUpdates`; DOM writes from a `MutationObserver`
filtered to `data-status`. Raw summaries in `loadtest/results/6.4-*.json`. React
DevTools re-render counts were **not** collected — the profiling build was
served, but the extension could not be driven from that harness.

**Phase 7 re-ran both halves in a foreground tab, and the result is parked.**
Message delivery was perfect on both sides — 4,978 broadcasts emitted and 4,978
received un-batched, 4,772 and 4,772 batched, **zero loss either way** — and
`immediate` again performed exactly one flush per message. `batched` produced
**14** flushes for those 4,772 messages. What could *not* be established is the
rAF cadence those 14 flushes were taken against: the tab measured **24.1 Hz
idle** against a 59 Hz panel, so the flush count is **not** reported as a
display-rate result, and **no ratio is published anywhere in this repository**.
Raw summaries: `loadtest/results/6.4-{immediate,batched}-visible-2026-08-22.json`.
See [Still not measured](#still-not-measured).

Full method and limits:
[`docs/phases/phase-6-reconciliation.md`](docs/phases/phase-6-reconciliation.md) §6.

### Multi-instance fan-out — three instances behind nginx

`BACKLOG.md` P2. Three Node instances behind nginx share one room per show over
a single Redis pub/sub channel. Rooms stay local — a socket is held by exactly
one process — and what crosses the instance boundary is the change itself.

**No sticky sessions, and that is a property of the protocol rather than a
tuning choice.** The seat socket is server-to-client only and its show is fixed
at upgrade time, so a connection carries no state an instance could own. nginx
round-robins, and the verification deliberately puts watcher and writer on
different instances.

The correctness claim is **exactly once**: the instance that made the change
publishes and does not also deliver locally, so it has one delivery path rather
than two. Measured over a 3-second window per action — 1 frame for a watcher on
another instance, **1 frame for a watcher on the same instance as the writer**
(where a double delivery would show), and 1 frame each for three watchers, one
per instance. Holds, releases and bookings all verified; show isolation holds.

| Condition | Topology | Holds/sec (3 runs) | Mean | Hold p95 |
|---|---|---|---|---|
| Phase 7 baseline | host, single instance, pre-M3 code | 499.5 (n=1) | **499.5** | — |
| **A** | host, single instance, current code | 384.6 · 395.0 · 400.5 | **393.4** | 98.8 ms |
| **C** | one container instance, direct | 374.3 · 359.1 · 351.6 | **361.7** | 108.2 ms |
| **B** | three instances behind nginx | 331.3 · 344.6 · 346.6 | **340.8** | 172.3 ms |

**Three instances did not raise hold throughput, and that is the honest
result.** The workload is bound by the shared Postgres and Redis, not by Node
CPU on one process, so spreading it over three adds hops without removing the
constraint. What this buys is availability and correct fan-out, not throughput.
The −21.2 % from the Phase 7 baseline to **A** is the cost of the change itself:
seat status is now resolved on every seat change whether or not *this* instance
has a watcher, because an instance cannot know whether another one does. **C**
exists so containerisation is not silently charged to the fan-out.

Same script and configuration as Phase 7 §7.3a — `loadtest/hold-throughput.js`
unchanged, show 21 (5,000 seats), 50 VUs × 4 seats, 45 s, 0 watchers, every run
at 0 conflicts and 0 failures. If Redis is unreachable the channel degrades to
local-only rather than failing: verified that instances stay up, holds fail
closed with 503, the seat map still renders without hold shading, Postgres still
refuses the second sale, and the fan-out recovers when Redis returns — re-tested
by re-running the delivery checks, not by trusting the status flag.

```bash
docker compose --profile multi up -d --build   # app1..app3 + nginx on :8080
```

Full method, per-check results and limitations:
[`docs/phases/phase-9-improvements.md`](docs/phases/phase-9-improvements.md).

### Phase 7 results table

Measured 2026-08-22 on the Phase 7 commit, against the local `docker compose`
stack, always with `RECONCILE_INTERVAL_SECONDS=0`. Machine: WSL2, **4 cores**,
Node v22.23.2, k6 v2.2.0, Postgres 17.11, Redis 7.4.10, single Node instance,
`pg` pool at its default of 10.

**Only the first row is a genuine before/after produced by a change to this
system.** Everything else is a single-point measurement and says so.

| Metric | Before | After | Workload | Script |
|---|---|---|---|---|
| **Seats sold twice** | **379 · 305 · 379** | **0 · 0 · 0** | 500 VUs, one seat, 3 runs each, re-seeded between | `seat-contention.js` |
| **Bookings from one replayed event** | *single-point* | **1** of 10,000 attempts | 500 VUs × 20 iters, concurrency 500 | `webhook-replay.js` |
| **Hold throughput** | *single-point* | **605/s** @ 50 VUs · **591/s** @ 200 VUs | uncontended, disjoint slices, 60 s | `hold-throughput.js` |
| **Availability latency — 160 seats** | *single-point* | **7.5 ms avg · 9.4 p95** | anonymous, 50/s for 60 s | `availability-latency.js` |
| **Availability latency — 5,000 seats** | *single-point* | **18.5 ms avg · 24.1 p95** | anonymous, 50/s for 60 s | `availability-latency.js` |
| **Cost of one WebSocket watcher** | **499/s** (none) | **373/s** (1) · **238/s** (50) | same hold workload, watchers varied | `hold-throughput.js` + `ws-fanout.js` |
| **WebSocket memory, 100→1000 sockets** | *single-point* | **no growth observed** — RSS settles ~96 MB, flat to +180 s | RSS from `/proc/<pid>/status` | `ws-fanout.js` |

Three results worth stating plainly:

- **Throughput is flat from 50 to 200 VUs while latency quadruples.** That is a
  queue, not headroom — the `pg` pool is pinned at its default of 10 connections
  while Postgres itself allows 100. Reported, deliberately not changed:
  pool sizing is architecture and is approval-gated.
- **31× the seats costs only ~2.5× the latency.** The availability query and its
  Redis `MGET` scale well in seat count.
- **One connected watcher costs a quarter of hold throughput** (499 → 373/s).
  The per-change broadcast is a scoped query plus an `MGET`, paid once per seat
  change no matter how many people are watching. The hub's early return when
  nobody is watching is doing real work.

These re-runs are **separate** from the 2026-08-19 numbers above: different
commit, before migrations `003`/`004`, before the reconciliation sweep and the
broadcast-on-booking existed. Two independent measurements of the same property,
never merged into one range.

Full method, the discarded runs, and the 7.3a findings:
[`docs/phases/phase-7-benchmarks.md`](docs/phases/phase-7-benchmarks.md).

### Still not measured

- **The `requestAnimationFrame` flush ratio.** Phase 7 re-ran both halves in a
  confirmed-visible foreground tab and **every broadcast was received** — 4,978
  and 4,772, zero loss — but the tab's rAF cadence measured **24.1 Hz idle**
  against a 59 Hz panel, and the flush count implies far lower still under load.
  At display rate the ratio would be roughly 4:1; at the observed cadence it
  computes to ~380:1. Those cannot both be true, so **no ratio is published**.
  `document.visibilityState === "visible"` is not sufficient — Chrome throttles
  rAF for an occluded window while still reporting the tab visible.
  [`docs/phases/phase-7-benchmarks.md`](docs/phases/phase-7-benchmarks.md) §5.
- **The authenticated availability path.** All latency figures are anonymous;
  a signed-in viewer gets a different merge.
- **Multi-instance throughput as a gain.** Three instances were measured, and
  they did **not** raise hold throughput on this hardware — see the
  multi-instance section above for what was measured and why.

The cold-start figure above is a deployment characteristic, not a performance
benchmark of the system.

## Known limitations

- **Only the Phase 2 codebase is deployed.** `main` is at `692ffcf`; Phases 3–7
  are unmerged, and the client is not deployed at all. The demo link serves the
  four catalogue endpoints and nothing else.
- **F-1 — a seat you hold from another client renders as taken until you
  refresh.** The server broadcasts every hold as `held` to the whole room, while
  the seat map reports a hold back to its *owner* as `available`. The client's
  compensating guard knows only the holds **this tab** took, so a hold owned by
  your account but taken elsewhere — a second tab, another device — renders dark
  and disabled, and turns green again on reload. Reproduced deterministically in
  Phase 8; low severity, self-correcting, and the owner can still re-take the
  seat, because a same-owner re-acquire refreshes the key rather than refusing
  it. The Phase 6/7 sightings of this were **a test-methodology artifact**: the
  load generator authenticated as the same account the browser was signed in as.
  It is **not** the WebSocket/HTTP race originally proposed — that hypothesis was
  tested and disproved, 0 of 25 frames arriving before their HTTP response.
- **The `pg` pool is pinned at its default of 10 connections**, and Phase 7
  measured it as the binding constraint. Reported and deliberately not changed:
  pool sizing is architecture and is approval-gated.
- No endpoint returns a user's bookings; a booking is visible only through the
  seat map.
- **Cancellation is server-side only, and refunds are recorded rather than
  executed.** `POST /api/bookings/:ref/cancel` exists, obeys a policy window and
  gives the seats back, but no client screen calls it and no money moves —
  `refund_pending` is a record of what is owed. It is also the second cause of
  that status, alongside Module 6.1's late payment; the two are told apart by
  `released_booking_seats.reason`, not by the status alone.
- **Hold creation is rate limited per user** — 30 requests per
  60 s by default, counted in Redis so the budget is shared across instances —
  but booking creation is not, and neither is anything else.
- No refresh tokens; a 7-day access token is the whole session model.
- No password reset, email verification, or roles.
- No rate limiting on the auth endpoints.
- Unit tests cover the pure modules only — **42 `node:test` tests** across
  seat-map geometry, the quadtree, the metrics histogram and the seat channel's
  degraded path (`npm test`). Everything else is still verified by scripted
  HTTP, SQL and browser checks per module: there are no route, service or
  end-to-end tests, and no CI to run any of it.
- The client is not deployed yet, so the cross-site cookie configuration
  (`SameSite=None; Secure`) is **not verified in production** — only the local
  same-site path is.
- Two money formatters co-exist: `client/src/money.js` for totals and a local
  helper inside `Legend.jsx`. Deliberate, to keep a module boundary; worth
  folding together.
- The seat map draws on a canvas by default, with a quadtree for hit-testing and
  viewport culling; the DOM grid stays behind `VITE_SEAT_RENDERER=dom` as the
  measured baseline and as the only accessible path. **The canvas is invisible
  to assistive technology** — no seat elements, no focus order, no
  `aria-pressed` — and canvas accessibility is still `BACKLOG.md` P3. No frame
  rate is claimed for the shipped draw loop.
- **Multi-instance runs locally, but only a single instance is deployed.**
  WebSocket updates fan out across processes over Redis pub/sub, verified at
  exactly one frame per watcher per change; `docker compose --profile multi`
  runs three instances behind nginx. `render.yaml` is untouched, so the deployed
  service is still one process, and merging and deploying remain separate,
  unmade decisions. If Redis is unreachable the fan-out degrades to local-only:
  a watcher on the instance that made the change is still told, one on another
  instance is not.
- **Benchmarks were measured locally** against the `docker compose` Postgres and
  Redis, never against the free-tier deploy, which would measure its throttling
  instead. The before/after ratio is the meaningful part; absolute numbers would
  differ on other hardware.
- **No CI.** Deliberately skipped in the eight-day build and recorded in
  `BACKLOG.md` P2 rather than left silent; verification was run per module.

## Documentation

- `PLAN.md` — build plan, phase by phase
- `BACKLOG.md` — work deliberately cut, and why
- `docs/phases/` — per-phase plans and close-outs
