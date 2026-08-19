# show-rush

Concurrent seat reservation system — the booking path for a cinema, built to be
correct under contention rather than merely functional.

**Status:** Phase 1 (Foundation) complete and deployed. Schema, authentication,
seed data, and the read APIs are live. Booking itself arrives in Phase 2 — there
is deliberately no way to book a seat yet.

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
- k6 — not needed yet; the load tests arrive in Phase 2 under `loadtest/`

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

## Architecture notes

- **Raw SQL over `pg`**, no ORM. Phase 2 needs precise control of the
  transaction and the constraint-violation catch — the exact mechanism an ORM
  would hide.
- **`availabilityService` is the only code that answers "is this seat taken".**
  One query path. Phase 4 extends it with Redis holds rather than adding a
  second.
- **`booking_seats` deliberately has no unique constraint** on
  `(show_id, seat_id)`. Phase 2 needs the double-booking race to be
  reproducible, and adds the constraint as its documented fix. This is not an
  oversight.

## Benchmarks

**Not measured.** Numbers land here in Phase 2 (booking contention, before and
after) and Phase 7, each with the command, environment, and workload used to
produce it. Until then this section stays empty rather than aspirational.

The cold-start figure above is a deployment characteristic, not a performance
benchmark of the system.

## Known limitations

- No booking endpoint yet — Phase 2.
- No refresh tokens; a 7-day access token is the whole session model.
- No password reset, email verification, or roles.
- No rate limiting on the auth endpoints.
- No automated test suite; Phase 1 was verified by scripted HTTP and SQL checks.
- Single instance, free tier. Benchmarks will be run locally, not on this host.

## Documentation

- `PLAN.md` — build plan, phase by phase
- `BACKLOG.md` — work deliberately cut, and why
- `docs/phases/` — per-phase plans and close-outs
