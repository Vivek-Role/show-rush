# Phase 4 — Redis holds

**Status:** IMPLEMENTED and VERIFIED. Modules 4.2–4.4 not committed at time of writing.
**Branch:** `feat/seat-holds`, cut from `feat/seat-map` @ `681ea8a` — **not** from `main`.
**Source of truth:** `PLAN.md` §Phase 4, `CLAUDE.md` §10, `docs/phases/phase-3-seat-map.md` §20
**Rules:** `CLAUDE.md` — not restated here
**Written:** 2026-08-21

> This document records what was built and what was measured. It does not
> restate the plan, and it does not revise Phase 2 or Phase 3 documentation.
> Where a check could not be run, it says so rather than implying coverage.

---

## Context

Phase 3 handed forward a seat grid whose `status` field already accepted a third
value, a selection hook with no rendering in it, and a working browser client.
Phase 4 fills that third value in: a seat is now unavailable if it is booked in
Postgres **or** held in Redis.

A hold is not a booking and confers no guarantee. The `UNIQUE (show_id, seat_id)`
constraint from Phase 2.4 remains the only thing that makes a seat sell exactly
once. Holds exist so that two people do not spend seven minutes on the same seat.

---

## 1. What exists at the end of Phase 4

A Redis-backed hold service with a fixed 420-second TTL; three endpoints over it;
an availability answer that merges Postgres and Redis on one query path; and a
browser client that takes a hold when a seat is selected, counts down from the
server's TTL, survives a refresh, and clears itself when the hold expires.

Two browser sessions cannot hold the same seat — `PLAN.md`'s done-when for this
phase — and a hold outlives the process that created it.

---

## 2. Module summaries

### 2.1 — Hold service (`server/src/services/holdService.js`, committed as `a9c8283`)

One Redis key per held seat: `hold:{showId}:{seatId}` → `{userId}`, `EX 420`.
The TTL is a constant, not configuration: it is a product decision, and making it
tunable would let a deploy quietly change what a hold means.

Exported surface, and nothing else: `acquireHolds`, `releaseHolds`,
`extendHolds`, `getHoldOwner`, `getHoldTtl`, plus `HOLD_TTL_SECONDS` and — added
in 4.3 — the `holdKey` formatter. There is deliberately **no** "which seats are
held for this show" function; that answer belongs to `availabilityService`
(`CLAUDE.md` §10).

Three single-key Lua scripts carry every state change:

- **acquire** — `SET … NX EX 420`; if `NX` refuses, the script compares the
  existing owner and, only when it is the same user, refreshes the TTL. Returns
  1 acquired, 2 refreshed, 0 held by another. A hold is never taken from anyone.
- **release** — compare-and-delete.
- **extend** — compare-and-expire.

There is no `GET`-then-`DEL` and no `GET`-then-`EXPIRE` anywhere. Between those
two round trips a hold can expire and be re-acquired, and the second command then
lands on a stranger's hold — a failure rare enough to survive testing and reach
production.

Multi-seat acquisition takes seats in **ascending numeric order** (the same
comparator `bookingService` uses for its inserts), so two overlapping requests
contend in the same sequence instead of each holding half of what the other
needs. All-or-nothing is a property of the return value and the rollback, **not**
of Redis: there is no transaction across keys.

**Rollback is best effort.** On a partial failure the holds created *by that call*
are compare-and-deleted in reverse order. If one of those deletes fails, that seat
stays held until its TTL expires — at most 420 seconds of a seat nobody can
select. Seats the caller already held are refreshed rather than created, and are
therefore not rolled back: they existed before the call and are still the
caller's own afterwards.

Redis unavailable → every function throws `HttpError 503 HOLDS_UNAVAILABLE`. The
guard is `isReady`, not `isOpen`: `isOpen` is already true while the socket is
still connecting, which is exactly the window in which node-redis queues commands
instead of refusing them. A hold that silently did not happen is a seat sold twice.

### 2.2 — Endpoints (`server/src/routes/shows.js`, `server/src/app.js`, `server/src/services/catalogService.js`)

| Endpoint | Behaviour |
|---|---|
| `POST /api/shows/:id/holds` | body `{seat_ids}`; 201 `{hold:{show_id, seat_ids, ttl_seconds}}` |
| `DELETE /api/shows/:id/holds` | body `{seat_ids}`; 200 `{released:{show_id, seat_ids}}` — only what was actually released |
| `GET /api/shows/:id/holds/ttl?seat_ids=…` | 200 `{holds:[{seat_id, ttl_seconds}]}` — **the caller's own holds only** |

All three require `requireAuth`. `POST` and `DELETE` are state-changing, so a
cookie-authenticated call must carry `X-Requested-With: show-rush`; Bearer
carries its own proof of intent and is exempt, exactly as Phase 3 established.

`seat_ids` is validated by the existing `seatIdList` (≤ 6, no duplicates, no
empty list). Every requested seat must belong to the show's screen — checked
against the `seats` table via a new `catalogService.seatIdsOnScreen`, because
seat identity lives in Postgres and `holdService` is not asked to know it. A seat
on another screen is a 404, not a 409: it is not a seat of this show at all.

A conflict returns **409 `SEATS_HELD`**, naming the losing seat, kept distinct
from the booking path's `SEATS_UNAVAILABLE` — a held seat is somebody else's
seven-minute window, not a sold seat, and a client can reasonably tell a user to
try again shortly for one and not the other. The seat id travels in the message
rather than a new field, because the `{error:{code,message}}` envelope is a
frozen Phase 1 contract.

`DELETE` on an expired or unowned hold is a success reporting nothing released.
Turning it into a 404 would make a client's cleanup path fail for succeeding.

`app.js` gained `DELETE` in the CORS methods list; without it the browser's
preflight refuses the request before it is ever sent.

### 2.3 — Availability merge (`server/src/services/availabilityService.js`)

`getSeatStatus(showId, { forUserId })` runs one `MGET` over the hold keys for the
seats Postgres just returned — a read of keys already known, never a scan — and
reports `held` where a hold exists. **Booked wins over held**: a sold seat does
not become less sold because someone is holding it.

`holdService` exports the key format to this module and nothing more. The merge
lives here because this module owns seat-status truth.

**The viewer's own holds report as `available` to them.** A hold exists so that
the person who took it can go on to book those seats; reporting it back as
unavailable would make it block the very thing it was taken for. Everyone else,
including anonymous visitors, sees `held`. That required `optionalAuth` on the
public seat map (a session is resolved when present, ignored when absent, never
refused) and passing the booking user through `bookingService`.

**Redis down on the read path degrades rather than fails.** The seat map returns
Postgres truth with holds unmerged and a logged warning. Holds were never the
guarantee, and a seat map that renders without hold shading beats no seat map.
The write path still fails closed. `BACKLOG.md` already records Redis as a hard
dependency of holds themselves.

### 2.4 — Frontend countdown (`client/src/seatmap/useSeatHolds.js`, `client/src/api/holds.js`, `SeatMapPage.jsx`, `BookingSummary.jsx`)

Selecting a seat takes the hold; deselecting releases it. The seventh seat is
never held, because the selection hook refuses it before a request is made. A
refused hold rolls the local selection back and refreshes the map.

The countdown is seeded from the server's `ttl_seconds` and **never** from
`Date.now()`. A client clock can be wrong by minutes, and a countdown computed
against a local deadline would confidently show a hold the server let go of long
ago. The earliest expiry among held seats governs the display.

A refresh re-syncs: seat ids are kept in `sessionStorage`, but they are only a
list of ids to *ask about* — the server confirms every one before anything is
restored. Returning from a backgrounded tab re-reads the real TTL rather than
trusting however many ticks the browser felt like delivering. On expiry the
selection clears with a plain message and the map reloads.

Holds are released after a booking commits, best effort and without waiting: a
hold outliving its booking is harmless, because the seat is already sold.

Signed out, selection still works and no hold is taken — the server is what
actually requires the session.

`'held'` needed no rendering change. Phase 3's `isSelectable` already refused any
status other than `available`, and `SeatButton` keys off the raw string.

### 2.5 — Crash test

Verification only; no implementation. Evidence in §5.

---

## 3. Verification environment

WSL2 Ubuntu · Node **v22.23.2** (pinned) · local Docker **Postgres 17.11** on
`localhost:5433` · local Docker **Redis 7** on `localhost:6380` · API on `:3000`
· **production client build** served by `vite preview` on `:5173` · Google Chrome
· `BOOKING_MODE=safe`.

Verified as one integrated feature at phase close, not module by module.

**Neon and Render were never contacted. No deploy, no push, no merge.**

---

## 4. Verification matrix

### 4.1 — Hold service, exercised through the endpoints

| Check | Result |
|---|---|
| TTL is exactly 420 in Redis | **PASS** |
| Another user cannot take a held seat | **PASS** |
| Owner re-acquiring own hold → 201, TTL refreshed | **PASS** — 100 → 420 |
| Extend restores the full window | **PASS** — 60 → 420 |
| Partial acquisition → 409, rollback leaves no partial holds | **PASS** |
| Other user's hold untouched by the failed attempt | **PASS** |
| Compare-and-delete: non-owner release leaves key and TTL intact | **PASS** |
| Owner release removes the key | **PASS** |
| Expiry removes the key and it stops being reported | **PASS** |
| Redis unavailable → fail closed | **PASS** — see §7 |

### 4.2 — Endpoints (27 checks, all PASS)

| Check | Result |
|---|---|
| POST · DELETE · GET-ttl unauthenticated → 401 `UNAUTHENTICATED` | **PASS** |
| Cookie POST and DELETE without `X-Requested-With` → 403 `CSRF_HEADER_REQUIRED` | **PASS** |
| Bearer needs no CSRF header → 201 | **PASS** |
| POST success → 201 `{hold:{show_id, seat_ids, ttl_seconds:420}}` | **PASS** |
| `seat_ids` returned in ascending numeric order | **PASS** — input `["5","3","4"]` → `["3","4","5"]` |
| Unknown show → 404 · seat on another screen → 404 · nonexistent seat → 404 | **PASS** |
| Refused foreign seat left no hold key | **PASS** |
| Seven seats · duplicates · empty list → 400 `VALIDATION_ERROR` | **PASS** |
| Conflict → 409 `SEATS_HELD` naming the seat | **PASS** — `"Seat 3 is already held by someone else"` |
| `SEATS_HELD` distinct from booking's `SEATS_UNAVAILABLE` | **PASS** |
| GET ttl returns own holds, shape `{seat_id, ttl_seconds}` | **PASS** |
| GET ttl hides another user's holds | **PASS** — `{"holds":[]}` |
| GET ttl accepts `a,b` and repeated params; missing → 400 | **PASS** |
| DELETE by non-owner → 200 releasing nothing | **PASS** |
| DELETE by owner → 200 with the seat; repeated → 200 empty, not 404 | **PASS** |
| CORS preflight allows DELETE from the client origin | **PASS** — `GET,POST,DELETE,OPTIONS` |

### 4.3 — Availability integration

| Check | Result |
|---|---|
| Another user's hold reads `held` | **PASS** |
| The owner's own hold still reads `available` | **PASS** |
| Anonymous viewer sees `held` | **PASS** |
| Booked seats still `booked`; booked wins over held | **PASS** |
| Seat payload shape unchanged | **PASS** — `id, row_label, seat_number, tier, price_paise, status` |
| Another user cannot book a seat you hold → 409 `SEATS_UNAVAILABLE` | **PASS** |
| The holder can book their own held seats → 201 | **PASS** |
| Booking path preserves Phase 2's constraint guarantee | **PASS** — see §6 |

### 4.4 — Browser flow (production build, real Chrome)

| Check | Result |
|---|---|
| Selecting acquires a hold | **PASS** — `hold:1:5 owner 1 ttl 410`, countdown `Seats held for 6:59` |
| Deselecting releases it | **PASS** — key gone |
| Six-seat maximum | **PASS** — 6 selected, `6 seats maximum.`, 7th `aria-disabled`, **exactly 6 hold keys and none for the refused seat** |
| Countdown follows server TTL | **PASS** |
| Refresh re-syncs TTL | **PASS** — after reload, 6 seats restored, countdown `6:08` against server TTLs 365–391; **not** reset to 7:00 |
| Background-tab recovery re-syncs | **PASS** — TTL cut to 15s out of band; after a background→foreground cycle the display re-synced to **0:06** |
| No stale client timer treated as authoritative | **PASS** — same evidence: the server's number overrode the local one |
| Expiry clears selection and reloads seat state | **PASS** — `No seats selected`, *"Your seat hold expired…"*, `sessionStorage` cleared, seat back to `available` |
| Hold conflicts roll back correctly | **PASS** — seat taken behind the rendered page; click → message, seat **not** selected, map refreshed to `held`, rest of selection kept |
| Another user's held seat is unselectable | **PASS** — `status="held"`, `disabled`, `aria-label "Seat B4, silver, held"`, click is a no-op |
| Logout behaviour | **PASS** — header `Log in`, button `Log in to book`, `/me` 401, and selecting while logged out creates **no** hold |
| Booking releases holds | **PASS** — `SR-94WEFZW78V`; both hold keys gone afterwards |

### Regression / integration

| Check | Result |
|---|---|
| `GET /api/movies` · `/api/movies/:id/shows` | **PASS** |
| Seatmap shape and 404 on unknown show | **PASS** |
| Bearer authentication | **PASS** |
| Cookie authentication | **PASS** |
| Session cookie remains httpOnly — `document.cookie` never contains `sr_token` | **PASS** |
| `/health` and `/` contracts unchanged | **PASS** |
| Production client build | **PASS** — 41 modules, 245.16 kB |
| Server startup, all routes registered | **PASS** |
| No unintended API regressions | **PASS** — no existing route's shape or status changed |

---

## 5. Module 4.5 — crash-test evidence

Procedure: acquire a hold through the running API, kill the server with
**SIGKILL** (`kill -9`), confirm the hold survives the process death, and watch
Redis release it at its TTL with nothing running.

```
=== Module 4.5 crash test — 2026-08-21T05:59:43+00:00 ===
POST /holds → 201 {"hold":{"show_id":"1","seat_ids":["100"],"ttl_seconds":420}}
hold acquired at epoch 1787291983 | redis owner=1 ttl=419
--- server pid 44879 — sending SIGKILL (kill -9) ---
server process is gone: dead
api reachable after kill: 000connection refused
--- hold immediately after the process died ---
owner=1 ttl=416
t+4s   owner=1 ttl=416      t+250s  owner=1 ttl=170
t+35s  owner=1 ttl=385      t+281s  owner=1 ttl=139
t+66s  owner=1 ttl=355      t+312s  owner=1 ttl=109
t+96s  owner=1 ttl=324      t+342s  owner=1 ttl=78
t+127s owner=1 ttl=293      t+373s  owner=1 ttl=47
t+158s owner=1 ttl=262      t+404s  owner=1 ttl=16
t+189s owner=1 ttl=232      t+434s  key is GONE (ttl -2)
t+219s owner=1 ttl=201
RESULT: released after 434s (nominal TTL 420s)
=== crash test finished — 2026-08-21T06:06:57+00:00 ===
```

**Result: PASS.** The hold survived the process being killed — owner intact, TTL
still counting, API refusing connections — and Redis released it by itself with
no application running.

**Stated precisely:** the key was last observed alive at **t+404s with ttl=16**
and first observed gone at **t+434s**. The poll interval was 30 seconds, so the
release occurred at **≈ t+420s**; 434s is the *detection* time, not the release
time. No claim is made to sub-poll-interval precision.

---

## 6. Phase 2 targeted regression, after applying local migration 002

### 6.1 The finding that made this necessary

Verification discovered that **migration `002_unique_booking_seats.sql` had never
been applied to the local Docker database**: `schema_migrations` held only
`001_init.sql` (applied 2026-08-18), `pg_constraint` on `booking_seats` carried
no unique constraint, and a direct duplicate insert succeeded. The local database
was sitting in the Phase 1.2 intentional-defect state.

Nothing in Phase 4 caused this, and no Phase 4 code touches migrations. It was
reported as a stop condition and left untouched until separately authorized.

Until the constraint existed, "the booking path preserves Phase 2's guarantee"
could not be verified. An earlier `1 × 201 / 19 × 409` run against the
unconstrained database was produced by the **application pre-check winning the
race**, not by the constraint, and was recorded as NOT VERIFIED rather than
passed on a technicality.

### 6.2 Migration, applied to local Docker Postgres only

Target confirmed before applying: `host=localhost port=5433 db=showrush`,
Postgres 17.11 — no `sslmode=require`, no Neon host. Zero duplicate rows present.

```
$ npm run migrate
skipped  001_init.sql
applied  002_unique_booking_seats.sql
1 applied, 1 skipped

applied migrations:
  001_init.sql                  2026-08-18T19:09:58.807Z
  002_unique_booking_seats.sql  2026-08-21T06:12:31.485Z
```

The existing migration command was used unchanged; no migration file was modified.

### 6.3 Constraint verification

```
unique constraints on booking_seats:
  booking_seats_show_id_seat_id_key — UNIQUE (show_id, seat_id)

unique indexes on booking_seats:
  booking_seats_pkey
  booking_seats_show_id_seat_id_key

duplicate (show_id, seat_id) rows: 0
```

`UNIQUE (show_id, seat_id)` is **present**, named exactly as `bookingService`
expects when it classifies `23505` by constraint name.

### 6.4 Contention result

20 simultaneous bookings of one seat — id 46, **C14**, show 1:

```
results: {"201":1,"409 SEATS_UNAVAILABLE":19}
201s: 1 | 409s: 19 | 5xx: 0
duplicate (show_id, seat_id) rows: 0
booking_seats rows for the contested seat: 1
unique constraint still present: booking_seats_show_id_seat_id_key

VERDICT: PASS
```

**1 × 201 · 19 × 409 · 0 × 5xx · 0 duplicates**, exactly one `booking_seats` row
for the contested seat, constraint still in place afterwards. Phase 2's database
guarantee survives Phase 4.

Also confirmed unchanged: `show transaction_isolation` → **read committed**.

### 6.5 What this is not

This is a **targeted regression check**, not a benchmark.

**The Phase 2 contention benchmark was NOT re-run and NOT modified.** No recorded
Phase 2 artifact, result file, or measurement was altered — `loadtest/results/`
is untouched, and `docs/phases/phase-2-booking-core.md` was not edited by this
phase. Twenty requests from one machine prove the constraint holds; they say
nothing about throughput and are not comparable to the 500-VU k6 runs.

### 6.6 Latency comparability — read this before comparing numbers

**Phase 4 adds a Redis hold-status read (`MGET`) to the booking availability
path.** `bookingService.assertSeatsAvailable` now calls `getSeatStatus`, which
merges holds, on both the naive and the safe path.

Behaviour with no holds present is identical — every key misses and every status
is unchanged — but the **timing is not**. Phase 2's recorded latency numbers were
measured on a build without this read, so they are **not directly comparable to
post-Phase-4 latency**. A post-Phase-4 run of the same script is a different
experiment, not a re-measurement.

The Phase 2 double-booking counts remain valid as recorded, and remain
reproducible at the commits they were taken at. If the naive baseline is ever
re-measured identically, it must be run at `692ffcf` or earlier.

---

## 7. Redis-down behaviour

The local Redis container was stopped, the checks below run, and the container
restarted immediately.

| Check | Result |
|---|---|
| `GET /api/shows/1/seatmap` | **200** — falls back to Postgres truth; the held seat read `available`, 13 booked seats still `booked` |
| `POST /api/shows/1/holds` | **503 `HOLDS_UNAVAILABLE`** |
| `DELETE /api/shows/1/holds` | **503 `HOLDS_UNAVAILABLE`** |
| `GET /api/shows/1/holds/ttl` | **503 `HOLDS_UNAVAILABLE`** |
| `GET /health` | **503** `{"status":"degraded","db":"ok","redis":"error"}` |
| `POST /api/bookings` | **201** — the Postgres path is unaffected |

Writes fail closed; reads degrade; booking keeps working. This is the approved
split, and no other fallback mechanism exists.

Separately, at service level, every hold function was confirmed to throw
`HttpError 503 HOLDS_UNAVAILABLE` both when the client exists but is not ready
and when `REDIS_URL` is unset. Each call was raced against a 5-second ceiling, so
a command silently *queued* awaiting a connection would have failed the check
rather than passed it. None queued.

---

## 8. Authentication and CSRF

| Check | Result |
|---|---|
| All three hold endpoints require a session | **PASS** — 401 `UNAUTHENTICATED` |
| Cookie-authenticated POST and DELETE require `X-Requested-With: show-rush` | **PASS** — 403 `CSRF_HEADER_REQUIRED` without it |
| Bearer is exempt from the CSRF header | **PASS** — 201 |
| `optionalAuth` never refuses a request | **PASS** — anonymous seat map returns 200 and sees `held` |
| Existing `requireAuth` behaviour unchanged | **PASS** — diff is purely additive (no lines removed); Bearer auth, cookie auth, the missing-token 401 and the CSRF rule all exercised |
| Session cookie stays httpOnly | **PASS** |
| Logout clears the session | **PASS** — `/me` 401 afterwards |

---

## 9. Approved deviations and their rulings

| # | Deviation | Ruling |
|---|---|---|
| 1 | `bookingService.js` modified — the authenticated user id is passed into the existing availability check so a holder can book their own held seats | **APPROVED**, strictly limited to the pass-through. `createBookingNaive`, `createBookingSafe`, the constraint handling, the isolation assertion and the `BOOKING_MODE` switch are unchanged |
| 2 | Phase 4 adds a Redis read to the booking availability path, affecting latency comparability | **APPROVED.** Benchmarks not re-run, measurements not modified, note recorded in §6.6 |
| 3 | `optionalAuth` added to `middleware/auth.js` | **APPROVED** — additive and minimal; `requireAuth` untouched |
| 4 | Two new client files: `api/holds.js`, `seatmap/useSeatHolds.js` | **APPROVED** as the API/timing-state separation for 4.4. No further abstraction |
| 5 | Redis-down read path degrades to Postgres truth while writes fail closed | **APPROVED** — graceful degradation, no other fallback |
| 6 | `catalogService.js` gained `seatIdsOnScreen` — outside the two files named in the 4.2 scope | Reported at the time; required by the approved seat-existence ruling, since `bookingService.resolveSeats` is private and off limits |
| 7 | `holdService.js` gained an exported `holdKey` in 4.3 | Comment and `export` only; no logic change |
| 8 | The conflicting seat id travels in the error `message`, not a new field | The `{error:{code,message}}` envelope is a frozen Phase 1 contract |

Additional rulings honoured: TTL stayed a fixed 420 with no `HOLD_TTL_SECONDS`
env var; no test framework, test file, package script, or dependency was added;
`GET …/ttl` remains a per-key owner/TTL lookup and no show-wide "which seats are
held" listing exists in `holdService`, the routes, or the client.

---

## 10. Known limitations, stated rather than glossed

- **`GET …/ttl` composes two round trips** (`getHoldOwner`, then `getHoldTtl`).
  Between them a hold can expire and be re-acquired, so in a rare interleaving
  the reported TTL could belong to the seat's new owner. It is a read-only leak
  of "seconds remaining" and nothing more. Closing it would need a combined
  owner-and-TTL script in `holdService`. Reported, not fixed.
- **The two-tab check used one browser profile.** Chrome shares one cookie jar
  across tabs, so the second party was a genuinely separate account
  (user id 2) acting over the API while the browser verified the receiving side.
  "Two parties cannot hold the same seat" is proven; "two Chrome tabs in two
  profiles" was not literally exercised.
- **A held seat that is already booked** is still refused correctly, but holds do
  not consult bookings at acquisition time — `POST /holds` can take a hold on a
  booked seat (**INFERRED** from `routes/shows.js`; not executed). Availability
  and booking both report it correctly, so no seat can be sold twice; the hold is
  simply useless. Not fixed in this phase.
- **Rollback and post-booking release are best effort.** A failed release leaves
  a hold until its TTL.
- Two failures in the first verification run were bugs in the throwaway
  verification harness, not in the code: a shared cookie jar under `Promise.all`,
  and an expectation of `{movies:[…]}` where `/api/movies` returns a bare array.
  Both were re-checked directly and pass.

---

## 11. Final environment state

**Local Postgres** (`localhost:5433/showrush`, Docker, 17.11)

| | Before verification | After |
|---|---|---|
| users / movies / screens / seats / shows / bookings / booking_seats | 1 / 5 / 3 / 504 / 20 / 5 / 11 | **1 / 5 / 3 / 504 / 20 / 5 / 11** |
| users | `1:demo@show-rush.dev` | **`1:demo@show-rush.dev`** |
| duplicate `(show_id, seat_id)` rows | 0 | **0** |
| migrations | `001` only | **`001` + `002`** |

Restored with `npm run seed`. The verification account and every test booking are
gone. The **only** lasting change is migration 002, which was the authorized
purpose.

**Local Redis** (`localhost:6380`, Docker): **0 keys — the keyspace is empty.**
No hold keys and no test data left behind. Both containers healthy.

**Neon: untouched.** No connection made, no query run.
**Render: untouched.** No service, env var, or deploy changed. Nothing deployed.

**Temporary verification files:** `verify-4.1.mjs`, `verify-4.1-failclosed.mjs`,
`phase4-http.mjs`, `db-state.mjs`, `diagnose.mjs`, `userb.mjs`, `redis-down.mjs`,
`crash-test.sh`, `schema-check.mjs`, `contention.mjs` — all held outside the
repository in the session scratchpad, **all deleted**. No verification artifact
was written into the repository and no repository file was modified by
verification. The browser tab was closed and both test servers stopped.

---

## 12. Git state and commit boundary

Branch `feat/seat-holds`, cut from `feat/seat-map` @ `681ea8a`.

| Commit | Contents |
|---|---|
| `a9c8283` — `feat: add Redis seat hold service` | Module 4.1 only, one file |
| *(uncommitted at time of writing)* | Modules 4.2, 4.3, 4.4 and this document |

Files changed by implementation:

```
 client/src/booking/BookingSummary.jsx           4.4
 client/src/pages/SeatMapPage.jsx                4.4
 server/src/app.js                               4.2
 server/src/middleware/auth.js                   4.3
 server/src/routes/shows.js                      4.2 + 4.3
 server/src/services/availabilityService.js      4.3
 server/src/services/bookingService.js           4.3
 server/src/services/catalogService.js           4.2
 server/src/services/holdService.js              4.3
 client/src/api/holds.js                   (new) 4.4
 client/src/seatmap/useSeatHolds.js        (new) 4.4
```

**No dependency was added, removed, or reinstalled** in this phase — `redis` was
already a server dependency. `package.json`, `package-lock.json`,
`server/package.json` and `client/package.json` are unchanged.

`README.md` was **not** modified. `main` is untouched at `692ffcf`, and Phase 3
remains unmerged on `feat/seat-map`. Nothing has been pushed, merged, or deployed.

---

## 13. Handoff to Phase 5

- **A hold that a payment can outlive.** 420 seconds is short enough that
  `PLAN.md` 6.1's late-payment case is real, and the TTL is the clock it is
  measured against.
- **The rule 5.3 depends on: commit Postgres first, release the hold after.**
  Phase 4 already releases holds only once a booking has been created, and does
  it best effort without waiting. Phase 5 must keep that order inside the payment
  transaction: releasing before the commit would free a seat whose payment
  succeeded.
- **`availabilityService` is still the single seat-status path**, now merging both
  stores. Payment must not add a second one.
- **`booking.status` is still `pending` everywhere.** Phase 4 changed nothing
  about the status lifecycle; `paid`, `cancelled` and `refund_pending` are
  untouched columns waiting for 5.2 and 6.1.
- **`getHoldOwner` is the seam** for "is this hold still the payer's?" if 6.1
  needs it, and it is already a per-key read.
- **Open, unchanged from Phase 3:** deploy the client as a Render static site and
  verify the cross-site cookie; fold `Legend.jsx` onto `money.js`; the Phase 2
  documentation mismatch recorded in `docs/phases/phase-3-seat-map.md` §18.
- **Open, new in Phase 4:** the `GET …/ttl` two-round-trip race (§10), and
  whether `POST /holds` should refuse a seat that is already booked (§10).
