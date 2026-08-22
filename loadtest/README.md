# loadtest

The evidence behind the build's two non-negotiable numbers — Phase 2's
before/after double-booking count, and Phase 5's replay test. A metric without a
reproducible script is a claim, so each script lives here, in the repository,
next to the SQL that counts what it produced.

| File | What it is |
|---|---|
| `seat-contention.js` | k6 script — N virtual users book the **same seat** on the **same show** at the same moment |
| `count-double-bookings.sql` | the measurement — how many seats ended up sold twice |
| `webhook-replay.js` | k6 script — N virtual users confirm the **same payment event** against the **same booking** (Phase 5.4) |
| `count-payment-replay.sql` | the measurement — how many rows one replayed event produced |
| `seat-churn.js` | k6 script — N virtual users hold and release seats to produce a sustained stream of WebSocket broadcasts (Phase 6.4) |
| `count-reconciliation.sql` | the measurement — what the reconciliation sweep and the late-payment path did |
| `hold-throughput.js` | k6 script — N virtual users acquire and release **disjoint** seat slices, for the hold-throughput claim (Phase 7.1) |
| `availability-latency.js` | k6 script — `GET /shows/:id/seatmap` at a fixed arrival rate, for the availability-latency claim (Phase 7.1) |
| `ws-fanout.js` | k6 script — opens N WebSocket connections and holds them, so server memory can be sampled from outside (Phase 7.3a instrument) |
| `results/` | raw k6 summaries behind each recorded number (created by Module 2.3) |

A script produces requests. It never reports the number itself — that comes from
the database afterwards, via the SQL.

`seat-churn.js` is the exception that proves the rule: it is a **generator**, not
a benchmark. It exists to load the *client*, and the number it prints is how many
broadcasts it caused — the denominator for counters read in the browser. Nothing
it prints is a performance figure for this system.

**Disable the sweep before any Phase 2 or Phase 5 run.** Set
`RECONCILE_INTERVAL_SECONDS=0`. A background job changing booking status
mid-measurement measures something other than the code under test.

---

## Never against Neon or Render

Both numbers are measured **locally**, against the `docker compose` Postgres.

- A naive run against production would write real double-bookings into the
  live database.
- A run against a free tier measures that tier's throttling, not this system.

`seat-contention.js` defaults to `http://localhost:3000` and has no production
default. Keep it that way.

---

## Prerequisites

- k6 — `k6 version` (built and verified against **v2.2.0**)
- The local stack up: `docker compose up -d` (Postgres **5433**, Redis **6380**)
- A migrated and freshly seeded database
- The server running locally in the mode being measured

**Run everything in one environment.** On this machine the repository, Node and
k6 all live inside WSL while Docker publishes to Windows `localhost`. A run
split across the two measures a network path rather than the booking code.
`k6` is at `~/.local/bin/k6`, which is on the `PATH` of a login shell.

---

## Running it

```bash
# terminal 1 — the server, in the mode you are measuring
BOOKING_MODE=naive npm start

# terminal 2 — the load
k6 run loadtest/seat-contention.js

# terminal 2 — the measurement
docker exec -i showrush-postgres \
  psql -U showrush -d showrush -f - < loadtest/count-double-bookings.sql
```

### Options

| Variable | Default | Notes |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | never a deployed URL |
| `SHOW_ID` | `1` | |
| `SEAT_ID` | first available seat on the show | deterministic on a freshly seeded database, so two runs are comparable without remembering an id |
| `VUS` | `500` | `PLAN.md` 2.2's workload |
| `BARRIER_MS` | `3000` | how long every VU waits before firing, so the attempts land together |
| `EMAIL` / `PASSWORD` | the demo account | |
| `SUMMARY_OUT` | unset | path for the raw JSON summary. Unset means nothing is written, so a rehearsal cannot overwrite a recorded run |

`setup()` refuses to start if the target seat is already taken — a run against a
booked seat would measure nothing and silently report zero.

---

## Reading the output

```
  iterations           500      how many attempts k6 actually ran
  dropped_iterations   0        attempts it could not run — must be read first
  201 created          N        bookings that succeeded
  409 conflict         N        attempts correctly refused
  5xx / no response    N        the load failing rather than the system refusing
  http_req_failed      0.00%    anything other than 201 or 409
```

**Read `dropped_iterations` and `http_req_failed` before the headline number.**
"0 double-bookings" means nothing if the load never landed — a run where every
request was refused at the socket also produces zero.

k6 only creates the `dropped_iterations` metric when it actually drops one, so
an absent metric is a measured zero, not a missing measurement. The summary
prints `0` in both cases.

Running against `BOOKING_MODE=safe` before Module 2.4 lands is unmistakable:
every attempt is a 501, so the run reports `5xx` equal to the VU count and
`http_req_failed 100.00%`. That is not a result — it is the wrong server.

`201 created` and the rest are k6's own counters, one per attempt. They are the
authoritative per-attempt figures; `http_reqs` is higher because `setup()` also
logs in and fetches the seat map.

A 409 is a **correct** response, so the script's expected statuses are 201 and
409. `http_req_failed` therefore means "the request did not land or the server
broke", which is the question that metric is here to answer.

---

## Why the barrier and the connection settings matter

Module 2.1 found that a client which quietly reuses sockets **serialises the
attempts and hides the race entirely** — eight concurrent Node `fetch` requests
for one free seat produced one success and seven conflicts, which reads exactly
like a system that is already correct. The same eight requests over separate
sockets double-booked every time.

So the script sets `noConnectionReuse: true` and holds every VU at a barrier
until a common start time. Both exist to make sure a zero result means the
system refused the work, not that the workload never overlapped.

If a future run reports suspiciously few conflicts, check these two first.

## The result varies between runs — record a range, not one number

A race is stochastic, and this one is. Verified at 500 VUs against a freshly
seeded database, three consecutive runs produced **213, 394 and 255**
double-bookings; at 50 VUs, **49, 4 and 26**. Every run produced some, none
dropped an iteration, and none returned a 5xx.

Two consequences for any recorded measurement:

- **Re-seed before every run.** `booking_seats` grows as runs accumulate, which
  slows the availability query and widens the race window, so successive runs
  against the same database are not comparable with each other.
- **Report several runs and their range**, with the run count stated. A single
  figure from a stochastic process is a sample presented as a constant.

The "after" number is not stochastic in the same way: the constraint either
holds or it does not, so 0 is 0.

---

## Reproducing the before/after numbers

The two numbers are **not** both reachable by flipping one environment
variable. Once Module 2.4 adds `UNIQUE (show_id, seat_id)`, the naive path can
no longer double-book: the database refuses it. The "before" number needs a
database without that constraint **as well as** `BOOKING_MODE=naive`.

### After (safe) — the current database

```bash
npm run migrate                        # 001 and 002 applied
npm run seed
BOOKING_MODE=safe npm start
k6 run loadtest/seat-contention.js
docker exec -i showrush-postgres \
  psql -U showrush -d showrush -f - < loadtest/count-double-bookings.sql
```

### Before (naive) — a disposable database at the pre-fix schema

```bash
docker exec showrush-postgres psql -U showrush -d postgres \
  -c "create database showrush_baseline"

# 001 only, applied directly: the fix is deliberately not present
docker exec -i showrush-postgres psql -U showrush -d showrush_baseline \
  < server/migrations/001_init.sql

export DATABASE_URL="postgres://showrush:showrush@localhost:5433/showrush_baseline"
npm run seed
BOOKING_MODE=naive npm start

k6 run loadtest/seat-contention.js
docker exec -i showrush-postgres \
  psql -U showrush -d showrush_baseline -f - < loadtest/count-double-bookings.sql
```

`schema_migrations` stays empty in that database on purpose — it is disposable,
recreated for the measurement and dropped afterwards. `count-double-bookings.sql`
prints the `booking_seats` indexes at the end precisely so every recorded run
carries proof of which schema it ran against.

Drop it when finished:

```bash
docker exec showrush-postgres psql -U showrush -d postgres \
  -c "drop database showrush_baseline"
```

**`BOOKING_MODE=naive` refuses to start with `NODE_ENV=production`.** The racy
path exists permanently so this measurement stays reproducible, never to serve
real users.

---

## Recording a run

Every number written down carries its method, or it is not a measurement:

machine and OS · Node, Postgres and k6 versions · commit SHA · date · `VUS` ·
`BARRIER_MS` · show and seat · `BOOKING_MODE` · the transaction isolation the
server logged at first booking · the `pg` pool size · whether the unrelated
`collab-postgres` container was running.

Save the raw summary alongside it:

```bash
SUMMARY_OUT=loadtest/results/2.3-naive-2026-08-20.json \
  k6 run loadtest/seat-contention.js
```

---

## `webhook-replay.js` — Phase 5.4, the idempotency test

The second non-negotiable in `PLAN.md`: replaying one payment event 10,000 times
**concurrently** must produce exactly one paid booking. Sequential replay only
proves the constraint exists; concurrent replay proves it holds under the race
that actually happens.

```bash
# terminal 1 — the server (BOOKING_MODE is irrelevant here; safe is the default)
npm start

# terminal 2 — the load
k6 run loadtest/webhook-replay.js

# terminal 2 — the measurement
docker exec -i showrush-postgres \
  psql -U showrush -d showrush -f - < loadtest/count-payment-replay.sql
```

`setup()` logs in, creates **one** booking on the first available seat of the
show, and refuses to start unless that booking is `pending` — a booking in any
other state would make every attempt a 409 and report zero while proving nothing.

### Options

| Variable | Default | Notes |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | never a deployed URL |
| `SHOW_ID` | `1` | |
| `VUS` | `500` | how many attempts are in flight at once |
| `ITERATIONS` | `20` | per VU; `VUS × ITERATIONS` is the attempt count |
| `BARRIER_MS` | `3000` | holds every VU's **first** attempt until a common start |
| `EVENT_ID` | `evt-replay-<timestamp>` | one id per run |
| `EMAIL` / `PASSWORD` | the demo account | |
| `SUMMARY_OUT` | unset | path for the raw JSON summary |

### 10,000 attempts at a concurrency of 500 — say it that way

The default workload is 500 VUs × 20 iterations. That is ten thousand attempts
with five hundred in flight at any moment, which is what this machine can
actually produce. It is **not** ten thousand simultaneous connections, and no
recorded number should say that it is.

`EVENT_ID` defaults to a fresh id per run for a reason: `payment_events.event_id`
is globally unique, so re-running against a database that already holds the
previous run's event would report 10,000 duplicates and zero creations — a run
that passes every eye test while measuring nothing. Re-seed between recorded
runs anyway.

### Reading the output

```
  201 created          1        the one confirmation that did the work
  200 duplicate        9999     replays, answered from the stored row
  409 conflict         0        a second, different event on a paid booking
  dropped_iterations   0        attempts k6 could not run — read this first
  http_req_failed      0.00%    anything other than 200 or 201
```

Then the SQL must show **one** `payment_events` row for the event, the booking
`paid`, and no extra `booking_seats` rows. A 200 is the correct answer to a
replay (`PLAN.md` 5.2 fixes it there deliberately), so the script's expected
statuses are 200 and 201.

**Pool depth bounds the concurrency, not the correctness.** `server/src/db/pool.js`
sets no `max`, so `pg` allows ten connections and the 500 in-flight requests
queue behind them in Node. That shapes latency in the summary; it has no bearing
on how many rows the event produced. Pool sizing is Phase 7.3b and
approval-gated.

---

## Phase 6.4 — seat churn, and the client counters

```bash
# terminal 1 — the API
RECONCILE_INTERVAL_SECONDS=0 npm start

# terminal 2 — the client under measurement
PROFILE=1 npm run build:client        # add VITE_SEAT_UPDATE_MODE=immediate for the "before"
npm run preview:client                # http://localhost:4173

# open http://localhost:4173/shows/20 in a VISIBLE, FOREGROUND tab, then:
# terminal 3 — the load
SHOW_ID=20 VUS=15 SEATS_PER_VU=2 STEP_MS=50 DURATION=20s   SUMMARY_OUT=loadtest/results/6.4-batched-$(date +%F).json k6 run loadtest/seat-churn.js
```

Read the browser-side numbers from the console:

```js
window.__srSeatUpdates   // { mode, messages, seatUpdates, flushes }
```

**The tab must be visible.** Chrome does not run `requestAnimationFrame` in a
hidden tab, and the hook falls back to a 1 s timer there instead. The recorded
2026-08-22 run was taken in a hidden tab and therefore measures the fallback
clock, not rAF — see `docs/phases/phase-6-reconciliation.md` §6.

---

## Phase 7 — the three new scripts

Added by Phase 7.1 so that each of `PLAN.md` 7.1's claims has one committed
script. `seat-contention.js` and `webhook-replay.js` already covered the first
two claims and were **not** modified.

`seat-churn.js` was deliberately left alone as well. Phase 6 built it as a
*generator* — it loads the browser and reports what it caused, never a
performance figure — and re-labelling it a benchmark afterwards would falsify
that record. `hold-throughput.js` is the benchmark; `seat-churn.js` is the
stimulus.

**Every Phase 7 run used `RECONCILE_INTERVAL_SECONDS=0`.** A sweep mutating
booking status mid-run measures something other than the code under test.

### `hold-throughput.js` — Phase 7.1, hold throughput

**Uncontended by construction.** `setup()` cuts the show's available seats into
one disjoint slice per VU and refuses to start if there are not enough, so two
VUs can never reach for the same seat. Contention is `seat-contention.js`'s
question and mixing the two produces a number that answers neither. Any 409 means
the slices overlapped: the summary prints a warning and the run must be discarded.

```bash
RECONCILE_INTERVAL_SECONDS=0 npm start          # terminal 1

SHOW_ID=21 VUS=50 SEATS_PER_VU=4 DURATION=60s \
  SUMMARY_OUT=loadtest/results/7.2d-holds-$(date +%F)-vus50.json \
  k6 run loadtest/hold-throughput.js            # terminal 2
```

| Variable | Default | Notes |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | never a deployed URL |
| `SHOW_ID` | `1` | needs `VUS × SEATS_PER_VU` free seats — use the stress show for large runs |
| `VUS` | `50` | |
| `SEATS_PER_VU` | `4` | seats per request; also sets how much work one acquire does |
| `DURATION` | `60s` | |
| `WATCHERS` | `0` | **a label only.** Recorded in the summary so the 7.3a broadcast-cost runs can be told apart. The script opens no sockets |
| `SUMMARY_OUT` | unset | path for the raw JSON summary |

Read `dropped_iterations` and `409 conflicts` before the rate. A run with
conflicts is not a throughput measurement.

### `availability-latency.js` — Phase 7.1, availability query latency

`GET /api/shows/:id/seatmap` — one Postgres query plus one Redis `MGET` whose
width is the seat count. **Anonymous on purpose:** the route is `optionalAuth` and
a signed-in viewer gets a different merge (their own holds read back as
available). Holding that constant keeps one variable in play, so **the
authenticated path is not covered by these numbers.**

`constant-arrival-rate`, not `constant-vus` — this is latency at a stated offered
load, not a search for the collapse point. A rate that could not be delivered
shows up in `dropped_iterations`, which is the first number to read: a load that
never landed has very cheap latency.

```bash
SHOW_ID=1  RATE=50 DURATION=60s HOLD_SEATS=0 \
  SUMMARY_OUT=loadtest/results/7.2e-availability-$(date +%F)-normal-cold.json \
  k6 run loadtest/availability-latency.js
```

| Variable | Default | Notes |
|---|---|---|
| `SHOW_ID` | `1` | run it against both a seeded screen and `npm run seed:stress` |
| `RATE` | `50` | requests per second offered |
| `DURATION` | `60s` | |
| `HOLD_SEATS` | `0` | pre-hold N seats so the `MGET` returns hits rather than an all-miss reply. Released in `teardown()` |

The summary records the seat count, which **is** the `MGET` width. A latency
figure without its seat count is not comparable to anything.

### `ws-fanout.js` — Phase 7.3a instrument

Not one of 7.1's four claims, and **it reports no performance number.** It opens
`SOCKETS` connections to `/ws?show_id=<id>`, holds them, and closes them, so that
something else can be observed.

**It cannot measure server memory** — a client has no view of a server's RSS.
Sample that from outside the process:

```bash
SHOW_ID=21 SOCKETS=1000 DURATION_MS=45000 k6 run loadtest/ws-fanout.js &
awk '/^VmRSS:/{print $2}' /proc/$(pgrep -f 'node src/index.js')/status
```

Uses `k6/websockets`. Verified against **k6 v2.2.0**, where `k6/net/websockets`
does not exist and `k6/experimental/websockets` is deprecated.

If `sockets opened` or `hello frames` disagree with `SOCKETS`, the server never
held the intended number of connections and any memory figure sampled against
that run is against the wrong denominator. The summary says so explicitly.

### Sampling the pool and the query plans

Neither needs a script. Both are Phase 7.3a, both read-only:

```bash
# pool utilisation during a load — pg allows 10 by default, Postgres allows 100
docker exec showrush-postgres psql -U showrush -d showrush -c \
  "select count(*), state from pg_stat_activity where datname='showrush' group by state"

# which indexes the availability queries actually use
docker exec showrush-postgres psql -U showrush -d showrush -c \
  "select relname, indexrelname, idx_scan from pg_stat_user_indexes order by relname"
```

### A note on measuring the client

`docs/phases/phase-7-benchmarks.md` §5 records why the Module 6.4 rAF number is
**still owed** after Phase 7. Both halves ran in a confirmed-visible foreground
tab and every broadcast was received, but the tab's `requestAnimationFrame`
cadence measured **24.1 Hz idle** against a 59 Hz panel, and the flush count
implies a far lower rate under load. The flush *ratio* is therefore not recorded
as a display-rate rAF result.

**If you re-run it, measure the cadence first** — idle and under load — and record
both beside the flush counts. `document.visibilityState === "visible"` is **not**
sufficient: Chrome throttles rAF hard for an occluded window while still
reporting the tab as visible.
