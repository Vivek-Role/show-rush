# Phase 1 — Foundation

**Status:** APPROVED — implementing
**Branch:** `feat/foundation`, from `main` @ `9d03329`
**Source of truth:** `PLAN.md` §Phase 1, `BACKLOG.md`, `docs/phases/phase-0-setup.md`
**Rules:** `CLAUDE.md` — not restated here
**Plan written:** 2026-08-19
**Plan approved:** 2026-08-19

---

## Context

Phase 0 delivered a deployed, deliberately single-file Express app with live
Postgres and Redis connections and a `/health` endpoint. It owns no schema, no
routes beyond `/` and `/health`, and no structure — `server/src/index.js` is 85
lines doing bootstrap, client construction, and routing at once, by design
(Phase 0 D2).

Phase 1 turns that into a real application: a module structure that Phases 2–6
can extend without rewriting, the full relational schema, authentication, seeded
demo data, and the read APIs the Phase 3 seat map consumes. It is the phase
Phase 2 stands on, and `PLAN.md`'s slip plan is explicit that if Phase 1 runs
long, the time comes out of features — never out of Phase 2. So the bias
throughout is toward the smallest thing that is correct and upgradeable.

---

## 1. Goal

A running server with a real schema, working registration and login, seeded demo
data, and read endpoints that return a seat map as JSON — structured so Phase 2
can add the booking transaction, Phase 3 can consume the seat map, and Phase 4
can union Redis holds into availability, none of them needing to restructure
what Phase 1 built.

**Done when** (`PLAN.md`): register, log in, fetch a seat map as JSON.

---

## 2. Scope

Five modules, strictly sequential. One branch, one commit per module.

`1.1 → 1.2 → 1.3 → 1.4 → 1.5`

Each module depends on all its predecessors. There is no parallelism to exploit:
1.2 needs the db module 1.1 creates, 1.3 needs the `users` table, 1.4 needs every
table, and 1.5 needs data to read.

---

## 3. In scope

- Restructure `server/src/index.js` into `config/`, `db/`, `routes/`,
  `middleware/`, `services/`, `lib/` — preserving `/health` exactly
- Error-handling middleware and a single JSON error response shape
- Graceful shutdown on `SIGTERM`
- Seven-plus-one tables, one migration file, a small migration runner
- `bookings.status` and `bookings.booking_ref` defined now, read by nothing until
  Phase 5 — `PLAN.md` requires one migration instead of three
- Register / login / `me`, JWT issue + verify, `requireAuth` middleware, bcrypt
  password hashing
- Re-runnable seed: 1 cinema, 3 screens, 5 movies, ~20 shows, seat layout JSON,
  a demo account, and a partially-booked seat map
- `GET /api/movies`, `GET /api/movies/:id/shows`, `GET /api/shows/:id/seatmap`
- `availabilityService` created here as the single seat-status query path

---

## 4. Out of scope

Anything below appearing in a diff is a stop condition.

| Excluded | Owner |
|---|---|
| Any booking write path, `POST /bookings` | Phase 2.1 |
| `UNIQUE (show_id, seat_id)` on `booking_seats` | Phase 2.4 — **deliberately absent** |
| `BOOKING_MODE` env var | Phase 2.1 |
| k6, `loadtest/`, any benchmark | Phases 2.2/2.3, 7 |
| React, Vite, `client/` | Phase 3.1 |
| `npm run seed:stress` / 5,000-seat layout | Phase 3.5 |
| Redis holds, TTL, Lua scripts | Phase 4 |
| Redis reads inside `availabilityService` | Phase 4.3 |
| `payment_events`, idempotency | Phase 5 |
| WebSockets, reconciliation job | Phase 6 |
| Index tuning, pool sizing | Phase 7.3b (approval-gated) |
| Refresh tokens, password reset, email verification, roles | Not built — recorded limitation |
| Admin UI, CI, rate limiting, everything in `BACKLOG.md` | Deliberately cut |

---

## 5. Module order

### 1.1 — Backend skeleton / restructure

**Goal.** Replace the single-file server with a module layout that every later
phase plugs into, changing no externally observable behaviour.

**Files.**

| File | Action |
|---|---|
| `server/src/index.js` | rewrite — bootstrap + listen + graceful shutdown only |
| `server/src/app.js` | new — `createApp()`: JSON body parser, route mounting, 404, error handler |
| `server/src/config/env.js` | new — loads `.env`, exports config, fails fast on missing required vars |
| `server/src/db/pool.js` | new — `pg.Pool` (moved verbatim, incl. TLS + `pool.on('error')` guard) |
| `server/src/db/redis.js` | new — redis client (moved verbatim, incl. error guard) |
| `server/src/routes/health.js` | new — `GET /` and `GET /health`, contract byte-identical |
| `server/src/middleware/error.js` | new — `notFound` + `errorHandler` |
| `server/src/lib/http-error.js` | new — `HttpError(status, code, message)` |

**Done when.** `GET /` and `GET /health` return exactly what they returned at
`9d03329` — same JSON keys, same 200/503 semantics; an unknown path returns a
JSON 404, not Express's HTML page; `SIGTERM` closes the HTTP server, then the
pool, then Redis, and exits 0.

**Model / effort.** Sonnet / low. Mechanical, but the `/health` contract is a
frozen interface — no drift.

---

### 1.2 — Database schema + migrations

**Goal.** The full relational schema in one migration, applied by a runner that
records what it ran, with the `booking_seats` unique constraint deliberately
absent.

**Files.**

| File | Action |
|---|---|
| `server/migrations/001_init.sql` | new — the entire schema |
| `server/src/db/migrate.js` | new — the runner (~60 lines) |
| `server/package.json` | modify — add `"migrate"` script |
| `package.json` (root) | modify — add root `"migrate"` passthrough |

**Runner behaviour.** `CREATE TABLE IF NOT EXISTS schema_migrations(version text
primary key, applied_at timestamptz default now())`; read `server/migrations/*.sql`
sorted by filename; for each unapplied version, run the file and insert the
version **inside one transaction**; print applied/skipped; exit non-zero on
failure. No `down`. Phase 2.4 adds `002_unique_booking_seats.sql`.

**Schema.**

```
users        id · email (unique, lowercased in app) · password_hash · name · created_at
movies       id · title · description · duration_minutes · language · certificate
             · poster_url · created_at
screens      id · cinema_name · name · layout jsonb · created_at
seats        id · screen_id FK · row_label · seat_number · tier · created_at
             UNIQUE (screen_id, row_label, seat_number)
shows        id · movie_id FK · screen_id FK · starts_at timestamptz · created_at
show_prices  show_id FK · tier · price_paise CHECK (> 0) · PK (show_id, tier)
bookings     id · booking_ref text UNIQUE · user_id FK · show_id FK
             · status text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','paid','cancelled','refund_pending'))
             · total_paise · created_at · updated_at
booking_seats id · booking_id FK · show_id FK · seat_id FK · created_at
             -- NO UNIQUE (show_id, seat_id). Phase 2.4 adds it. Intentional.
```

`booking_seats.show_id` is carried denormalized because Phase 2.4's constraint is
`UNIQUE (show_id, seat_id)` and must be enforceable on this table alone.

All ids `bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`. All timestamps
`timestamptz`. All money integer paise — never floats.

**Indexes** — FK hygiene only, no tuning: `seats(screen_id)`,
`shows(movie_id)`, `shows(screen_id, starts_at)`, `bookings(user_id)`,
`bookings(show_id)`, `booking_seats(booking_id)`, and a **non-unique**
`booking_seats(show_id, seat_id)`. The last one supports the availability query
and does **not** prevent the Phase 2.1 race.

**Done when.** `npm run migrate` on an empty database creates all 8 tables and
`schema_migrations`; re-running reports 0 applied and changes nothing; and
`SELECT indexdef FROM pg_indexes WHERE tablename='booking_seats'` shows **no
unique index on (show_id, seat_id)**.

**Model / effort.** Opus / medium. The schema is the contract for six phases; the
intentional omission is easy to "helpfully" fix.

---

### 1.3 — Authentication

**Goal.** Register, log in, and prove identity on later requests.

**Files.**

| File | Action |
|---|---|
| `server/src/routes/auth.js` | new |
| `server/src/services/authService.js` | new — hash, verify, sign, find/create user |
| `server/src/middleware/auth.js` | new — `requireAuth` |
| `server/src/lib/validate.js` | new — ~30 lines of hand-rolled input checks |
| `server/src/app.js` | modify — mount `/api/auth` |
| `server/src/config/env.js` | modify — `JWT_SECRET`, `JWT_EXPIRES_IN` |
| `.env.example` | modify — same two vars |
| `server/package.json` | modify — `bcryptjs`, `jsonwebtoken` |

**Endpoints.**

```
POST /api/auth/register  {email, password, name}  201 {user, token}
                                                  409 EMAIL_TAKEN
                                                  400 VALIDATION_ERROR
POST /api/auth/login     {email, password}        200 {user, token}
                                                  401 INVALID_CREDENTIALS
GET  /api/auth/me        Bearer <token>           200 {user}
                                                  401 UNAUTHENTICATED
```

`user` is `{id, email, name}` — `password_hash` never leaves the service layer.
JWT is HS256, payload `{sub: userId}`, default expiry 7d. Login returns the same
401 whether the email is unknown or the password is wrong.

**Done when.** Register → 201 with a token; the same email again → 409; login
with a wrong password → 401; `/me` without a token → 401, with the token → 200
and the correct user; no response body anywhere contains `password_hash`.

**Model / effort.** Opus / medium. Security-touching; enumeration and leak
avoidance matter more than the line count suggests.

---

### 1.4 — Seed data

**Goal.** A re-runnable script producing a demo-ready dataset, with the `seats`
table authoritative and the layout JSON derived from the same generator.

**Files.**

| File | Action |
|---|---|
| `server/src/seed/index.js` | new — entry point, transaction, reset + insert |
| `server/src/seed/layout.js` | new — one generator emitting `{layout, seats[]}` |
| `server/src/seed/data.js` | new — the movie/screen/show literals |
| `server/package.json` | modify — `"seed"` script |
| `package.json` (root) | modify — root `"seed"` passthrough |
| `README.md` | **deferred to phase close-out** — demo credentials (`BACKLOG.md` P0) |

**Content.** 1 cinema, 3 screens with distinct layouts, 5 movies, ~20 shows
across the next 7 days, tier prices per show, one demo user
(`demo@show-rush.dev`), and a handful of pre-existing bookings so the seat map is
partially booked rather than uniformly empty.

**Re-runnable.** Everything runs in one transaction that begins with
`TRUNCATE booking_seats, bookings, show_prices, shows, seats, screens, movies, users
RESTART IDENTITY CASCADE`. `schema_migrations` is never touched. The script
**refuses to run when `NODE_ENV=production`** unless `--force` is passed, so a
stray invocation cannot wipe the deployed database.

**Seat identity.** `layout.js` returns the rows/columns/tiers/aisles structure
**and** the flat seat list from a single pass. The seat list is inserted into
`seats`; the structure is stored in `screens.layout`. One generator, so the two
cannot disagree — and `seats` remains the only thing foreign keys point at. The
generator takes row/column counts as parameters so Phase 3.5's stress variant is
a call, not a rewrite; that variant is **not** added here.

**Done when.** `npm run seed` succeeds on a migrated database; running it a
second time succeeds and yields identical row counts; for every screen,
`COUNT(seats)` equals the number of seat cells in that screen's layout JSON.

**Model / effort.** Sonnet / medium. Mostly data, with one real invariant.

---

### 1.5 — Read APIs

**Goal.** The three endpoints Phase 3 consumes, with seat status coming from a
single owned query path.

**Files.**

| File | Action |
|---|---|
| `server/src/routes/movies.js` | new |
| `server/src/routes/shows.js` | new |
| `server/src/services/catalogService.js` | new — movies and shows queries |
| `server/src/services/availabilityService.js` | new — **owns seat-status truth** |
| `server/src/app.js` | modify — mount `/api/movies`, `/api/shows` |

**Endpoints** (public — no auth; a recruiter must be able to browse without
registering, per `BACKLOG.md` P0):

```
GET /api/movies              → [{id, title, language, certificate,
                                 duration_minutes, poster_url}]
GET /api/movies/:id/shows    → {movie, shows: [{id, starts_at, screen: {id, name}}]}
                               404 NOT_FOUND
GET /api/shows/:id/seatmap   → {show, screen: {id, name, layout},
                                seats: [{id, row_label, seat_number, tier,
                                         price_paise, status}]}
                               404 NOT_FOUND
```

`status` is `'available' | 'booked'` in Phase 1. Phase 4.3 adds `'held'` by
unioning Redis into `availabilityService` — **the response shape does not change
then**, only the set of possible values, which is why the field is a string
rather than a boolean.

`availabilityService.getSeatStatus(showId)` is the **only** function that answers
"is this seat taken". It runs one query — `seats LEFT JOIN booking_seats` filtered
to non-cancelled bookings — joined to `show_prices` on tier. Nothing else in the
codebase queries `booking_seats` for availability.

**Done when.** All three return correct data against the seeded database; the
seat map's seat count matches the screen's `seats` row count; seats seeded as
booked report `booked` and the rest `available`; unknown ids return a JSON 404.

**Model / effort.** Opus / medium. `availabilityService`'s boundary is the part
Phase 4 depends on; the SQL itself is straightforward.

**Phase effort:** ~1 to 1.5 days. Hotspots: 1.2 (schema is a six-phase contract)
and 1.3 (security surface).

---

## 6. Dependencies

**Two new runtime packages.** Approved in principle (Q2); the install itself is
confirmed at 1.3, not before.

| Package | Why required | Existing dependency? | Alternative considered |
|---|---|---|---|
| `bcryptjs` | password hashing (1.3) | no | native `bcrypt` — compiles via node-gyp; Phase 0 R1 flagged exactly this failure class. `node:crypto` scrypt — zero deps, but deviates from `PLAN.md` and hand-rolls salt handling |
| `jsonwebtoken` | JWT issue + verify (1.3) | no | `jose` — modern, but heavier API for HS256; hand-rolled HMAC — not worth owning |

Manifests changed: `server/package.json`, `package-lock.json`. Root
`package.json` gains script passthroughs only, no dependencies.

**Explicitly not added:** `zod`/`joi` (hand-rolled `validate.js` covers three
endpoints), `knex`/`prisma` (raw SQL is the approved direction),
`node-pg-migrate` (see D1), `supertest`/`vitest` (see Q4), `helmet`/`cors`
(no browser client until Phase 3.1 — that phase owns CORS).

---

## 7. Architecture / design decisions

### D1 — Plain `.sql` files + a small runner
**Choice.** Numbered `.sql` files in `server/migrations/`, applied in filename
order by `server/src/db/migrate.js`, tracked in a `schema_migrations` table, each
migration in its own transaction.
**Why.** Phase 2.4's headline move is `ALTER TABLE booking_seats ADD CONSTRAINT
... UNIQUE (show_id, seat_id)` and catching `23505`. That SQL should be readable
verbatim in the repo, with nothing translating it. Zero new dependencies, ~60
lines, and the whole mechanism is explainable in one breath.
**Rejected.** `node-pg-migrate` — a real library, but it adds a JS DSL over the
one piece of SQL this project exists to demonstrate, plus down-migrations that an
8-day build will never run. Bare `psql -f` — no record of what ran, not
re-runnable, and no path to running against Neon from a script.

### D2 — `bigint` identity keys, `booking_ref` as the public identifier
**Choice.** Internal `bigint GENERATED ALWAYS AS IDENTITY` primary keys;
`bookings.booking_ref` is an opaque UNIQUE string used by the API and by Phase 5's
payment flow.
**Why.** `seats` gets large (Phase 3.5 seeds ~5,000 rows per screen) and
`booking_seats` indexes it on every availability query — narrow keys matter there.
`PLAN.md` 1.2 requires `booking_ref` regardless, which already solves the
"don't expose enumerable ids" concern where it actually matters.
**Rejected.** `uuid` everywhere — wider indexes, and it makes `booking_ref`
redundant against an explicit plan requirement.

### D3 — `show_prices` as an eighth table
**Choice.** `show_prices(show_id, tier, price_paise)`, PK `(show_id, tier)`.
**Why.** Phase 3.4 needs a price breakdown and `PLAN.md`'s seven tables have
nowhere to put a price. A table joins straight into the seat-map query, so the
price arrives with the seat in one round trip, and the tier values are visible to
SQL rather than buried in a JSON blob.
**Deviation, reported not silent:** `PLAN.md` 1.2 names seven tables. This is an
eighth. **Rejected:** `shows.tier_prices jsonb` (keeps the count, moves the join
into app code, tier keys unconstrained against `seats.tier`); a flat
`shows.price_paise` (smallest, but reduces Phase 3.4's "price breakdown" to a
multiplication).

### D4 — `availabilityService` created in 1.5, not Phase 4
**Choice.** The service that owns seat-status truth exists from Phase 1, with a
Postgres-only implementation.
**Why.** `PLAN.md` 4.3 mandates one query path and forbids `holdService` from
exposing a second availability read. Creating the boundary while there is only
one data source means Phase 4.3 adds a union inside an existing function instead
of retrofitting a boundary across working code.
**Rejected.** Inline SQL in the route now, extract later — the extraction always
happens under time pressure, in the phase that can least afford it.

### D5 — One generator for layout JSON and seat rows
**Choice.** `seed/layout.js` emits the presentation structure and the flat seat
list from the same pass.
**Why.** `PLAN.md` 1.2 and `CLAUDE.md` §10 both forbid a second source of truth
for which seats exist. Two independent generators would drift the first time a
layout changes, and the symptom would surface as a foreign-key error in Phase 2.
**Rejected.** Hand-authored layout JSON checked in alongside an independent seat
insert — exactly the drift the rule exists to prevent.

### D6 — Error contract `{ error: { code, message } }`
**Choice.** Every non-2xx response from `/api/*` is
`{"error":{"code":"SCREAMING_SNAKE","message":"human readable"}}`. `HttpError`
carries status and code; the error middleware is the only place that formats.
`5xx` never echoes the internal message.
**Why.** Phase 3 needs to branch on a stable machine-readable value, and Phase
2.4's 409 and Phase 4's hold conflicts both depend on it existing before they
arrive.
**Note.** `/health` and `GET /` are **exempt** — their Phase 0 shapes are frozen.

### D7 — Bootstrap split: `index.js` boots, `app.js` assembles
**Choice.** `createApp()` returns a configured Express app with no side effects;
`index.js` reads config, constructs clients, calls `createApp()`, listens, and
handles `SIGTERM`.
**Why.** It is the cheapest structure that makes the app startable without
binding a port, which is what any future test or in-process load harness needs.
**Rejected.** Everything in `index.js` — the Phase 0 shape, explicitly handed to
1.1 to replace.

---

## 8. Cross-phase constraints

Carried forward and binding:

1. **`/health` response shape is frozen** — `{status, db, redis}`, 200 healthy /
   503 degraded, status values only, no topology leakage. 1.1 moves the handler
   and must not touch the contract. `GET /` is frozen too — `render.yaml` uses it
   as the health check path.
2. **Raw SQL via `pg`.** No ORM, no query builder, in any module.
3. **No `UNIQUE (show_id, seat_id)` on `booking_seats`.** Protected intentional
   defect. Phase 2.4 owns it. Do not add it, and do not flag it as a bug.
4. **`seats` owns seat identity.** Layout JSON is presentation. Every foreign key
   points at `seats.id`.
5. **`availabilityService` owns seat-status truth.** One query path. Phase 4's
   `holdService` must not expose a second availability read.
6. **`.env.example` is the single source of truth for env vars.** Anything reading
   a var not listed there is a bug.
7. **`bookings.status` and `booking_ref` are defined now, read by nothing until
   Phase 5.** One migration, not three.
8. **`server/` + `client/` layout.** `client/` is Phase 3.1's; not created here.
9. **No secrets committed.** `JWT_SECRET` goes to `.env` locally and the Render
   dashboard — never to a file in the repo.

**Handed to Phase 2:** the schema, `availabilityService`, the error contract, the
migration runner, and a seeded database Phase 2.3's baseline run can target.

---

## 9. Verification strategy

Targeted per module; the full sequence runs once at close-out. Everything is run
against **local Docker Postgres on port 5433 / Redis on 6380** (Phase 0 remapped
these — `collab-postgres` and `collab-redis` hold the defaults).

| Module | Checks |
|---|---|
| 1.1 | `curl localhost:3000/` → 200; `/health` → 200 with `{status,db,redis}`; **diff the `/health` body against the `9d03329` output** — byte-identical; stop the Postgres container → 503, `db:"error"`, no hang; `curl /nope` → JSON 404; `kill -TERM` → exits 0 |
| 1.2 | `npm run migrate` on a **fresh scratch database** (`createdb showrush_verify` inside the container) → 8 tables + `schema_migrations`; re-run → 0 applied; `pg_indexes` on `booking_seats` → **no unique index**; insert two bookings for the same `(show_id, seat_id)` → **both succeed** (proves the defect is intact) |
| 1.3 | register → 201; duplicate email → 409; login wrong password → 401; login correct → 200 + token; `/me` no token → 401; `/me` with token → 200; check that no response body carries `password_hash`; confirm the stored hash is not the plaintext |
| 1.4 | `npm run seed` → succeeds; run again → succeeds, identical counts; per-screen `COUNT(seats)` == layout cell count; `NODE_ENV=production npm run seed` → refuses |
| 1.5 | all three endpoints against seeded data; seat-map count == `seats` count for that screen; a seeded-booked seat reports `booked`; unknown ids → 404 |

**Phase close-out, run once, in order:** fresh scratch DB → `migrate` → `seed` →
boot → register → login → `/me` → `movies` → `shows` → `seatmap`, then
`/health` against the Docker stack. Each command and its exact output recorded
below.

**Not verified in Phase 1** — and not to be claimed: concurrency behaviour,
double-booking counts, query latency, pool behaviour under load, anything about
holds. Phase 2 and Phase 7 own those.

**No performance numbers are produced by this phase.** If a number is not
measured with a recorded command, it is written as "Not measured."

---

## 10. Completion criteria

- [ ] All five modules implemented, one commit each on `feat/foundation`
- [ ] Per-module verification passed, results recorded PASS/FAIL/NOT RUN
- [ ] Phase close-out sequence (§9) passed end to end on a fresh database
- [ ] `/health` contract verified unchanged against `9d03329`
- [ ] `booking_seats` confirmed to have **no** unique constraint
- [ ] No out-of-scope files touched; nothing from Phase 2 started
- [ ] Demo credentials and setup steps added to `README.md` (separate authorized commit)
- [ ] Known limitations recorded
- [ ] `git status` clean of `.env` and `node_modules`; no secrets tracked
- [ ] No AI attribution in commits or files
- [ ] This document updated with the close-out section
- [ ] Git state reported; merge to `main` **not** performed

---

## 11. Risks / known limitations

**R1 — "Helpfully" adding the unique constraint.** The single highest risk in the
phase. Writing `booking_seats` without `UNIQUE (show_id, seat_id)` looks like an
oversight, and the natural instinct is to add it. Doing so destroys Phase 2's
before-number permanently. *Mitigation:* an explicit comment in `001_init.sql`
pointing at Phase 2.4, and a 1.2 verification step that asserts two conflicting
rows both insert.

**R2 — `booking_seats.show_id` is denormalized.** It duplicates
`bookings.show_id`. Without it, Phase 2.4's constraint cannot be expressed on one
table. It can disagree with its parent booking until Phase 2.4's transaction
sets both. *Accepted deliberately; recorded as a known limitation.*

**R3 — Silent `/health` drift during 1.1.** Moving the handler is exactly when a
key gets renamed or a status code changes. *Mitigation:* diff the response
against the pre-restructure output rather than eyeballing it.

**R4 — Env-var loading changes under Render.** `index.js` currently resolves the
repo-root `.env` explicitly because `npm start` runs with `cwd=server/`, and
Render supplies vars with no `.env` present. `config/env.js` must preserve both
behaviours. A `config/env.js` that fails fast on a missing var will **crash the
deployed service** the moment `JWT_SECRET` is not set in the Render dashboard —
so the dashboard var is set *before* 1.3 is pushed.

**R5 — Seed `TRUNCATE`.** Destructive by design. Guarded by the
`NODE_ENV=production` refusal, but it will wipe the local database on every run.
That is the intended meaning of "re-runnable" and is stated in the README.

**Known limitations recorded by this phase:**
- No refresh tokens; a 7-day access token is the whole session model (`PLAN.md` 1.3)
- No password reset, email verification, roles, or account deletion
- No rate limiting on auth endpoints (`BACKLOG.md` P2)
- Read endpoints are unauthenticated
- No automated test suite (Q4)
- `booking_seats.show_id` denormalization (R2)

---

## 12. Files expected to change

**New (20 in `server/`):**

```
server/migrations/001_init.sql
server/src/app.js
server/src/config/env.js
server/src/db/pool.js
server/src/db/redis.js
server/src/db/migrate.js
server/src/lib/http-error.js
server/src/lib/validate.js
server/src/middleware/error.js
server/src/middleware/auth.js
server/src/routes/health.js
server/src/routes/auth.js
server/src/routes/movies.js
server/src/routes/shows.js
server/src/services/authService.js
server/src/services/catalogService.js
server/src/services/availabilityService.js
server/src/seed/index.js
server/src/seed/layout.js
server/src/seed/data.js
```

**Modified (5):**

```
server/src/index.js       1.1 — rewritten to bootstrap only
server/package.json       1.2 script, 1.3 deps, 1.4 script
package.json (root)       script passthroughs only
package-lock.json         on install
.env.example              1.3 — JWT_SECRET, JWT_EXPIRES_IN
README.md                 close-out — demo credentials, setup (separate commit)
```

This document itself is **not committed** — see Q6.

---

## 13. Files that must remain untouched

`PLAN.md` · `BACKLOG.md` · `CLAUDE.md` · `.claude/settings.json` ·
`docs/phases/phase-0-setup.md` · `docker-compose.yml` · `render.yaml` ·
`.gitignore` · `.nvmrc`

`client/` is not created. `loadtest/` is not created.

Needing any file outside §12 is a stop condition: report the exact file, the
minimum change, and wait.

---

## 14. Decisions — all resolved 2026-08-19

| ID | Decision | Resolution |
|---|---|---|
| — | Migration approach | Plain `.sql` files + a small runner (D1) |
| — | Password hashing | `bcryptjs` — pure JS, no native build |
| — | Pricing storage | `show_prices` table (D3) |
| — | Primary keys | `bigint` identity + public `booking_ref` (D2) |
| **Q1** | API error contract | Approved — `{error:{code,message}}` across `/api/*` (D6) |
| **Q2** | New dependencies | `bcryptjs` + `jsonwebtoken` approved in principle; the install is confirmed at 1.3 |
| **Q3** | Migrations to Neon; `JWT_SECRET` location | `render.yaml` unchanged. Migrations run manually from local against Neon. `JWT_SECRET` set by hand in the Render dashboard, as 0.6 did for `DATABASE_URL` |
| **Q4** | Automated tests | None this phase. Verification is scripted curl + SQL with recorded output. Revisit at Phase 2 |
| **Q5** | Partially-booked seat map in the seed | Yes — direct inserts only, no endpoint, no service |
| **Q6** | `README.md` / `docs/phases/` tracking | This document stays **untracked**. The `README.md` update is a separately authorized commit at close-out |
| **Q7** | Branch and commit shape | Single `feat/foundation` branch, five commits, no module branches |

---

## 15. Plan verified against the repository

Verified 2026-08-19 by direct inspection at `9d03329`, not assumed.

| `PLAN.md` / instructions assume | Actually in the repo | Mismatch |
|---|---|---|
| `server/src/index.js` is simple and single-file | 85 lines: dotenv, pool, redis, `/`, `/health`, listen. No `routes/`, `services/`, `db/` | none — as documented |
| Express available | `express@^5.2.1` — **Express 5**, not 4 | **yes — M2** |
| `pg`, `redis`, `dotenv` installed | all present in `server/package.json` | none |
| `bcrypt`, `jsonwebtoken` available | **neither installed** | expected — Q2 |
| Repo layout `server/` + `client/` | `server/` only; no `client/` | none — Phase 3.1 owns it |
| Postgres on 5432, Redis on 6379 | **5433 and 6380** — Phase 0 remapped around `collab-*` | **yes — M3** |
| Node version | root `engines` pins `22.23.2`; `.nvmrc` matches; `render.yaml` `NODE_VERSION` matches | none |
| `docs/`, `README.md` are local-only | **all tracked** in git as of `9d03329` | **yes — M1** |
| Working tree clean, `main` == `origin/main` | confirmed | none |
| `feat/foundation` exists | did not exist; `module/0.6-*` and `module/0.7-*` remain local | expected |

### Concrete problems found

**M1 — The "must not be committed" rule contradicts the repository.**
The instruction lists `PLAN.md`, `BACKLOG.md`, `README.md`, `CLAUDE.md`,
`.claude/`, and `docs/` planning files as files that must not be committed. All
six are **already tracked**; `docs/phases/phase-0-setup.md` was committed in
`9d03329` ("docs: close out Phase 0 setup"). Read as "do not commit *changes* to
these going forward". Consequences: this document stays untracked, and the
`BACKLOG.md` P0 README items land only via a separately authorized commit (Q6).
Nothing is untracked or removed — that would rewrite Phase 0's recorded intent.

**M2 — Express 5, not Express 4.** This changes 1.1 concretely, in ways that are
silent failures rather than errors:
- Async route handlers that reject are forwarded to the error middleware
  automatically in v5. No `express-async-handler`, no wrapper, no such dependency.
- `req.query` is a getter and is no longer mutable — 1.5 must not assign to it.
- Path patterns changed (`path-to-regexp` v8); `*` wildcards must be written as
  named parameters. The 404 handler is therefore a bare `app.use(notFound)`, not
  `app.all('*', ...)`.
- `res.status(...).send(body)` no longer accepts a numeric-string body edge case;
  everything here uses `res.json`, so this does not bite.

**M3 — Non-default local ports.** 5433 / 6380, because another project holds the
defaults. Every verification command in §9 must use them, and this document must
record it — otherwise a "verified locally" claim is against the wrong database.
`.env.example` already documents both.

**M4 — `render.yaml` `healthCheckPath: /`, not `/health`.** Not a Phase 1 defect,
but 1.1 must keep `GET /` returning 200 or **the deployed service will be marked
unhealthy and restarted**. `GET /` is therefore part of the frozen contract.

**M5 — `PLAN.md` names seven tables; this plan has eight.** `show_prices` (D3),
approved. Stated here so it is a recorded deviation, not a silent one.

### Unnecessary complexity removed

- **No `cinemas` table.** One cinema; `screens.cinema_name` is a text column.
  Multi-cinema is `BACKLOG.md` P4, deliberately cut.
- **No `citext` extension.** `email text UNIQUE`, lowercased in the service.
- **No Postgres `ENUM` for `bookings.status`.** A `CHECK` does the same job and
  Phase 5 extends it with a plain `ALTER`; `ALTER TYPE ... ADD VALUE` cannot run
  inside a transaction, which would break the migration runner.
- **No `down` migrations.** Forward-only; the runner stays ~60 lines.
- **No validation library, CORS, helmet, logger, or test framework.** Each is a
  dependency for a problem Phase 1 does not have. CORS is Phase 3.1's.
- **No repository/DAO layer.** Services own their SQL directly. An abstraction
  over `pg` is exactly what `PLAN.md` rejected an ORM to avoid.
- **No `routes/index.js` aggregator.** Mounts live in `app.js`.

---

## 16. Phase close-out

**Status:** COMPLETE — merged to `main`, pushed, and deployed to production.
**Completed:** 2026-08-19

### Built

| Module | Commit | What landed |
|---|---|---|
| 1.1 Backend skeleton | `828e236` | `server/src/index.js` split into `app.js`, `config/env.js`, `db/pool.js`, `db/redis.js`, `routes/health.js`, `middleware/error.js`, `lib/http-error.js`. Bootstrap, listen, and `SIGTERM` shutdown live in `index.js`; `createApp()` assembles without binding a port. |
| 1.2 Schema + migrations | `b6d486c` | `server/migrations/001_init.sql` — eight tables — and `server/src/db/migrate.js`, a ~75-line forward-only runner tracking `schema_migrations`. |
| 1.3 Authentication | `609a398` | `routes/auth.js`, `services/authService.js`, `middleware/auth.js`, `lib/validate.js`. bcryptjs hashing, HS256 tokens, `JWT_SECRET` asserted at import. |
| 1.4 Seed data | `103fc9d` | `seed/index.js`, `seed/layout.js`, `seed/data.js`. One generator emits both the layout JSON and the seat rows; whole seed runs in one transaction after `TRUNCATE ... RESTART IDENTITY CASCADE`. |
| 1.5 Read APIs | `d184b54` | `routes/movies.js`, `routes/shows.js`, `services/catalogService.js`, `services/availabilityService.js`. Three public endpoints; `availabilityService` owns seat-status truth. |

**Merge commit:** `866c682` — `Merge branch 'feat/foundation'`, parents
`9d03329` (Phase 0) and `d184b54`. Non-fast-forward, module history preserved;
25 files changed, +1361 / −77.

### Deployed to production

- Render service `show-rush` (`srv-da275sqjnfac73antuhg`), Singapore, free plan,
  `npm ci` / `npm start`, `healthCheckPath: /`.
- Deploy branch moved `feat/foundation` → `main` after the merge.
- Live deploy `dep-da2m36nqj5pc7383hr1g`, commit **`866c682`**, status `live`,
  07:56:10 → 07:56:44 UTC on 2026-08-19.
- Backed by **Neon PostgreSQL 17.11** (Singapore) and **Upstash Redis**
  (Singapore).

### Verification

**49/49 deployed checks passed** against `https://show-rush.onrender.com`, run
at commit `d184b54` whose tree is byte-identical to `866c682`:

| Group | Result |
|---|---|
| `GET /` and `GET /health` | 200; `{"status":"ok","db":"ok","redis":"ok"}`; both byte-identical to the Phase 0 baseline |
| Register / duplicate | 201 with token; 409 `EMAIL_TAKEN` |
| Login / wrong password / unknown email | 200 with token; 401 `INVALID_CREDENTIALS`; unknown email response **byte-identical** to wrong password |
| `/me` valid / absent / malformed / tampered / wrong scheme | 200; four × 401 `UNAUTHENTICATED` |
| `GET /api/movies` | 200, 5 movies, title-ordered |
| `GET /api/movies/1/shows` | 200, 4 shows, each with its screen |
| `GET /api/shows/1/seatmap` | 200, Audi 1, 160 seats, 160 distinct ids, 0 null prices |
| Seeded booked seats | `A1 A2 C5 C6 C7 I3 I4` — exact match to the seed |
| `GET /api/shows/6/seatmap` | 200, Audi 3 (IMAX), 260 seats, 3 booked |
| 404 / 400 contract | unknown movie, unknown show, non-numeric id, out-of-range bigint, unknown route → `NOT_FOUND`; malformed JSON → `INVALID_JSON`; missing fields → `VALIDATION_ERROR` |
| `password_hash` leakage | absent from every response body |

Earlier, the same suite plus a full `migrate → seed → boot → register → login →
/me → movies → shows → seatmap` sequence passed on a fresh local database, with
the degraded path (Postgres stopped → 503 in ~6 ms, no hang) and `SIGTERM`
shutdown (exit 0) also verified.

**Neon** — `001_init.sql` applied and confirmed: 9 tables, 9 foreign keys, 19
indexes, `bookings.status` CHECK, `UNIQUE (booking_ref)`. Seeded to 1 user, 5
movies, 3 screens, 504 seats, 20 shows, 53 prices, 5 bookings, 11 booked seats.
An account registered through the **deployed** API was observed in Neon,
proving the live service writes there.

**Upstash** — confirmed by the deployed `/health` reporting `redis:ok`, which
runs `PING` against the service's own `REDIS_URL`.

**Not measured.** No latency, throughput, or concurrency numbers were produced.
The only recorded figure is the Phase 0 cold start (23.2–27.0 s), a deployment
characteristic rather than a benchmark.

### Intentional defect preserved

`booking_seats` has **no** unique constraint on `(show_id, seat_id)` — verified
three ways: absent from `001_init.sql`; `pg_indexes` on Neon reports 0 unique
indexes covering those columns and no unique/exclusion constraints beyond the
primary key; and two conflicting rows both inserted successfully during 1.2's
verification.

The non-unique index `booking_seats_show_id_seat_id_idx` supports the
availability query and does nothing to prevent the race. `availabilityService`
uses `EXISTS` rather than a join precisely because a seat can legitimately
appear on more than one booking row until Phase 2.4 lands.

Phase 2.1 needs this race reproducible; Phase 2.4 adds the constraint as its
documented fix. Removing it early would destroy a non-negotiable measurement.

### Deviations from the approved plan

```
Plan says: seven tables (PLAN.md 1.2).
Actual:    eight — show_prices was added.
Why:       Phase 3.4 needs a price breakdown and the seven named tables have
           nowhere to put a price. Recorded as decision D3.
```

```
Plan says: config/env.js fails fast on missing required vars.
Actual:    assertAuthConfig() is called from authService, not at config load.
Why:       asserting at config load would make `npm run migrate` require a
           signing secret it has no use for. Verified both ways.
```

```
Plan says: 1.5 returns screen as {id, name, layout}.
Actual:    also includes cinema_name.
Why:       already on the row, and the seat map is where a UI would show it.
```

```
Plan says: bcrypt (PLAN.md 1.3).
Actual:    bcryptjs.
Why:       pure JS, no native build step; Phase 0 R1 flagged native-addon
           compilation as a real failure risk. Same hash format. Approved.
```

```
Plan says: BCRYPT_ROUNDS shared with authService.
Actual:    duplicated as a constant in seed/index.js.
Why:       importing authService would drag in its JWT_SECRET assertion.
```

**One real defect found and fixed during 1.5:** ids that passed the digits check
but overflowed `bigint` reached Postgres and produced a 500. `isId()` now bounds
the value; such ids return 404. Fixed within the same module, before commit.

### Deployment incident

Three deploys of `d184b54` failed with `Error: JWT_SECRET is not set.` at
`config/env.js:28`, thrown via `authService.js:10`. Build succeeded every time;
the start command exited 1 before binding a port, and Render rolled back to
Phase 0. Root cause was configuration — the variable was not reaching the
service — confirmed from the actual Render logs and reproduced from a clean
clone. Resolved by setting a non-empty `JWT_SECRET` on the service; deploy
`dep-da2kg5jl550s73efvcu0` then went live.

This was the failure mode plan risk **R4** predicted. The fail-fast check
behaved correctly: it refused to start a service that would otherwise have
signed forgeable tokens. It was not relaxed to make the deploy pass.

### Deferred findings

From the merge-gate integration review. None blocked the merge.

**High — H1.** `JWT_SECRET` is not declared in `render.yaml`, and the service
has `blueprint_sync` history. A future sync could strip dashboard-only
variables and reproduce the boot failure above. The durable fix is
`- key: JWT_SECRET` with `sync: false`, an infrastructure change previously
rejected as decision Q3. **Open.**

**Medium.**
- `bookings.updated_at` has no trigger and no code path writes it; Phase 5 will
  need to set it explicitly.
- No automated test suite (decision Q4); revisit at Phase 2, where correctness
  claims begin.

**Low.**
- `availabilityService` imports `isId` from `catalogService`; a shared
  `lib/ids.js` would be cleaner once Phase 4 needs the same helper.
- `authService`, `catalogService`, and `availabilityService` do not guard a null
  `pool`, so a deploy missing `DATABASE_URL` would 500 rather than 503.
- `booking_seats.show_id` is denormalized and can disagree with
  `bookings.show_id`; Phase 2.4's transaction must set both.
- Seeded show times anchor to midnight UTC today, so day-0 shows can be in the
  past depending on when the seed runs.
- `show_prices` is joined with `LEFT JOIN`; a tier without a price row would
  yield `price_paise: null`. No constraint enforces coverage.
- No CORS — Phase 3.1 owns it, when a browser origin exists.

### Discovered, deferred

```
Issue: The deploy verification account deployverify1787119730387@show-rush.test
       (id 4) remains in the Neon production database.
Why out of scope: Neon was read-only for that task; removing it was not
       authorized.
Recommended action: delete the row, or re-run the seed, before the demo is
       shown to anyone.
```

```
Issue: pg emits a deprecation warning on every Neon connection — sslmode
       'require' is currently treated as an alias for 'verify-full', but will
       adopt weaker libpq semantics in pg v9 / pg-connection-string v3.
Why out of scope: current behaviour is the stronger one; nothing is wrong today.
Recommended action: track in BACKLOG.md. db/pool.js keys its TLS config off the
       literal substring 'sslmode=require', so a future major could silently
       downgrade verification.
```

### Known limitations carried forward

No booking endpoint until Phase 2 · no refresh tokens · no password reset, email
verification, or roles · no rate limiting on auth · read endpoints
unauthenticated · no automated tests · single instance, free tier · benchmarks
will be run locally, never against the free tier.

### Final Git state

| Ref | Commit |
|---|---|
| `main` (local and `origin/main`) | `866c682` |
| `feat/foundation` (local and origin) | `d184b54` — retained, not deleted |

History was not rewritten: `9d03329` and `d184b54` are both ancestors of
`main`. All six new commits are authored and committed by
`vivek <vivekrole6110@gmail.com>`, with no AI attribution trailers anywhere.
`.env` remains untracked; no secret values are present in any tracked file
across any ref.

### Final Render state

| Field | Value |
|---|---|
| Service | `show-rush` — `srv-da275sqjnfac73antuhg` |
| Branch | `main` |
| Live deploy | `dep-da2m36nqj5pc7383hr1g` at `866c682` |
| autoDeploy | `yes`, trigger `commit` |
| URL | <https://show-rush.onrender.com> |

### Handed to Phase 2

The schema and migration runner (Phase 2.4 adds `002_*.sql`),
`availabilityService` as the single seat-status query path, the
`{error:{code,message}}` contract, working authentication for booking requests,
and a seeded database — local and on Neon — that Phase 2.3's baseline run can
target.

**Frozen interfaces:** the `/` and `/health` response shapes; the error
contract; `seat.status` as a string; `.env.example` variable names.

**Must not change without approval:** raw SQL over an ORM; the `server/` +
`client/` layout; `seats` as the authority on seat identity;
`availabilityService` as the single availability read; and the absent
`booking_seats` unique constraint until Phase 2.4 deliberately adds it.
