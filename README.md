# show-rush

Concurrent seat reservation system — the booking path for a cinema, built to be
correct under contention rather than merely functional.

**Status:** Phase 2 (Booking correctness) complete on `feat/booking-core`, with
measured before/after concurrency numbers below. Phase 1 — schema,
authentication, seed data and the read APIs — is deployed. Seat holds arrive in
Phase 4 and payment in Phase 5, so a booking is created and stays `pending`.

## Demo

<https://show-rush.onrender.com>

**Demo account** — no need to register:

```
demo@show-rush.dev
demo-password
```

Try it:

```bash
curl https://show-rush.onrender.com/health
curl https://show-rush.onrender.com/api/movies
curl https://show-rush.onrender.com/api/movies/1/shows
curl https://show-rush.onrender.com/api/shows/1/seatmap
```

**Cold start: 23.2–27.0 seconds.** The free tier sleeps after ~15 minutes idle,
so the first request after a quiet period is slow. Subsequent requests are
sub-second.

This is a **deployment characteristic of the free tier, not a performance
benchmark of the system.** It measures how long Render takes to wake a sleeping
container, and says nothing about how the booking path behaves under load.
Those numbers arrive in Phase 2 and Phase 7.

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

### Run

```bash
npm run dev     # node --watch
npm start
```

Then `curl localhost:3000/health` — expect `{"status":"ok","db":"ok","redis":"ok"}`.

## API surface (Phase 1)

Every non-2xx response under `/api` is
`{"error":{"code":"SCREAMING_SNAKE","message":"..."}}`. The code is the stable
part; clients branch on it.

### Health

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | `{"service":"show-rush","status":"ok"}` — Render's health check target |
| `GET` | `/health` | `{"status","db","redis"}` — 200 healthy, 503 degraded |

### Auth

| Method | Path | Body / auth | Success | Errors |
|---|---|---|---|---|
| `POST` | `/api/auth/register` | `{email, password, name}` | `201 {user, token}` | `409 EMAIL_TAKEN`, `400 VALIDATION_ERROR` |
| `POST` | `/api/auth/login` | `{email, password}` | `200 {user, token}` | `401 INVALID_CREDENTIALS` |
| `GET` | `/api/auth/me` | `Authorization: Bearer <token>` | `200 {user}` | `401 UNAUTHENTICATED` |

Tokens are HS256, default lifetime 7 days. Passwords are hashed with bcrypt;
`password_hash` never appears in a response. An unknown email and a wrong
password return the identical 401, so the endpoint cannot be used to enumerate
accounts.

### Catalogue and seat map

All public — browsing does not require an account.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/movies` | `[{id, title, description, duration_minutes, language, certificate, poster_url}]` |
| `GET` | `/api/movies/:id/shows` | `{movie, shows: [{id, starts_at, screen: {id, name}}]}` |
| `GET` | `/api/shows/:id/seatmap` | `{show, screen: {id, name, cinema_name, layout}, seats: [...]}` |

Unknown or malformed ids return `404 NOT_FOUND`.

Each seat is `{id, row_label, seat_number, tier, price_paise, status}`. `status`
is `"available"` or `"booked"` today; Phase 4 adds `"held"` without changing the
shape. Prices are integer paise, never floats.

`screen.layout` is presentation data — rows, columns, tiers, aisle positions.
**The `seats` table is the authority on which seats exist**; the layout only
describes how to draw them.

### Booking

| Method | Path | Body / auth | Success | Errors |
|---|---|---|---|---|
| `POST` | `/api/bookings` | `{show_id, seat_ids}` · `Authorization: Bearer <token>` | `201 {booking}` | `409 SEATS_UNAVAILABLE`, `404 NOT_FOUND`, `400 VALIDATION_ERROR`, `401 UNAUTHENTICATED` |

Up to **6 seats** per booking, enforced server-side. All-or-nothing: if any seat
is taken, the whole request is refused and nothing is written. The booking is
returned as `{booking_ref, show_id, status, total_paise, seats}` with `status`
always `"pending"` — Phase 5 owns payment.

`409 SEATS_UNAVAILABLE` is the same code whether the seat was already gone when
the request arrived or was lost in a race at commit time. A client should not
have to know which layer caught it.

## Architecture notes

- **Raw SQL over `pg`**, no ORM. Phase 2 needs precise control of the
  transaction and the constraint-violation catch — the exact mechanism an ORM
  would hide.
- **`availabilityService` is the only code that answers "is this seat taken".**
  One query path. Phase 4 extends it with Redis holds rather than adding a
  second.
- **`UNIQUE (show_id, seat_id)` on `booking_seats` is the guarantee**, added by
  `002_unique_booking_seats.sql`. The availability check in front of it is
  convenience; the database is the only participant that sees every transaction,
  so it is the only one that can decide.
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

### Everything else

**Not measured.** Hold throughput, availability-query latency and WebSocket
behaviour arrive in Phase 7, each with the command, environment and workload
used to produce it.

The cold-start figure above is a deployment characteristic, not a performance
benchmark of the system.

## Known limitations

- No seat holds yet — Phase 4. A seat is free until someone books it.
- No payment, so every booking stays `pending` forever — Phase 5.
- No endpoint returns a user's bookings; a booking is visible only through the
  seat map.
- No cancellation, and no rate limiting on booking creation.
- No refresh tokens; a 7-day access token is the whole session model.
- No password reset, email verification, or roles.
- No rate limiting on the auth endpoints.
- No automated test suite; Phase 1 was verified by scripted HTTP and SQL checks.
- Single instance, free tier. Benchmarks will be run locally, not on this host.

## Documentation

- `PLAN.md` — build plan, phase by phase
- `BACKLOG.md` — work deliberately cut, and why
- `docs/phases/` — per-phase plans and close-outs
