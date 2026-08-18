# Build Plan — Concurrent Seat Reservation System

Solo build with Claude Code. One branch per phase.

**Non-negotiables:** Phase 2's before/after concurrency numbers, and Phase 5's
idempotency test. Everything else is cuttable.

**Rule for every metric:** record what *you* measure. Never a number from a
conversation or a blog post.

---

## Phase 0 — Setup
`main`

Do not skip. Deploy problems discovered at the end kill the project.

- [ ] Repo, `main` branch, `.gitignore`, `.env.example`
- [ ] **Decisions recorded before any code is written:** package manager,
      pinned Node version (`.nvmrc` + `engines`), repo layout (`server/` +
      `client/`), and data access — raw SQL or ORM
- [ ] Hello-world Express app deployed to Render or Railway
- [ ] Neon Postgres provisioned, connection verified **from the deployed app**
- [ ] Upstash Redis provisioned, connection verified from the deployed app
- [ ] **`docker-compose.yml` — local Postgres + Redis**, matching the hosted
      major versions. Phases 2 and 7 benchmark against these, never the free tier
- [ ] k6 installed locally, `k6 version` recorded
- [ ] `/health` endpoint returning DB + Redis status

**Recommended:** raw SQL (`pg`) over an ORM. Phase 2 turns on precise control of
the transaction and the constraint-violation catch — an ORM abstracts exactly
the thing being demonstrated.

**Deliberately skipped:** CI. Recorded in `BACKLOG.md`, not left silent.

**Done when:** the deployed URL reports both connections healthy, **and**
`docker compose up` gives a local Postgres + Redis the app can point at.

---

## Phase 1 — Foundation
`feat/foundation`

**1.1 Project skeleton** — Express, folder structure (`routes/`, `services/`,
`db/`), env config, DB + Redis clients, error middleware.

**1.2 Schema** — `users`, `movies`, `screens`, `seats`, `shows`, `bookings`,
`booking_seats`. Foreign keys only. **No unique constraint on booking_seats yet**
— Phase 2 adds it deliberately.

Define now, though nothing reads them until Phase 5: `bookings.status`
(`pending | paid | cancelled | refund_pending`) and `bookings.booking_ref`.
One migration instead of three.

**Ownership:** the `seats` table is authoritative for seat identity and foreign
keys. The layout JSON is presentation only — rows, columns, tiers, aisles. Never
two sources of truth for which seats exist.

**1.3 Auth** — register, login, JWT issue/verify, middleware, bcrypt. No refresh
tokens; record that as a known limitation rather than discovering it later.

**1.4 Seed script** — 1 cinema, 3 screens, 5 movies, ~20 shows. Seat layout as
JSON (rows, columns, tiers, aisles). Re-runnable.

**1.5 Read APIs** — list movies · shows for a movie · seat layout + status for a show.

**Done when:** register, log in, fetch a seat map as JSON.
**Trap:** no admin UI. The seed script is the admin UI.

---

## Phase 2 — Booking correctness ⚠️ the most important phase
`feat/booking-core`

Ahead of the seat map deliberately: it depends on nothing in the UI, and it is
the one phase that must never absorb schedule pressure.

**2.1 Naive booking endpoint** — separate `SELECT` availability check, then
`INSERT`. Deliberately racy; under READ COMMITTED this fails reliably. Assert the
isolation level at runtime and record it — don't assume the default.

Keep this path permanently behind `BOOKING_MODE=naive|safe`. Once 2.4 lands the
unique constraint the "before" number is otherwise unreproducible, and an
unreproducible headline metric is a claim, not a measurement.

**2.2 k6 script** — 500 VUs, same seat, simultaneous. Commit to `loadtest/`,
together with the SQL that counts double-bookings.

**2.3 Baseline run** — run against **local** Postgres (`docker compose`), never
the free-tier deploy or you'll benchmark their throttling. Count the
double-bookings. Record k6's own `dropped_iterations` and `http_req_failed` too:
"0 double-bookings" means nothing if the load never landed.

**2.4 The fix** — `UNIQUE (show_id, seat_id)` on `booking_seats`. Wrap the
multi-seat insert in a transaction. Catch constraint violations, return a clean
409.

**2.5 Verification** — same script, `BOOKING_MODE=safe`, expect 0. Record
before/after with method: machine, Postgres version, VU count, isolation level.

**Done when:** you have two numbers you can defend, both re-runnable today by
flipping one env var.

---

## Phase 3 — Seat map UI
`feat/seat-map`

**3.1 App shell** — React + Vite, routing, auth context, API client.

**3.2 Seat grid** — render from layout JSON, tiers colour-coded, aisles as gaps,
legend. **State lives in a hook, rendering lives in the component.** This split is
what makes the canvas upgrade cheap later.

**3.3 `useSeatSelection` hook** — select/deselect, max-6 rule, running total.
Zero rendering logic inside it.

**3.4 Booking summary** — selected seats, price breakdown, proceed button wired
to the Phase 2 endpoint.

**3.5 Baseline measurement** — commit a 5,000-seat layout as a named seed variant
(`npm run seed:stress`), not a throwaway. React DevTools Profiler: re-renders per
click, click-to-paint. **Write both numbers in the README now**, with the seed
command beside them. Without a reproducible "before", the canvas work in
`BACKLOG.md` P1 is unclaimable.

**Done when:** browse shows, select seats, see a total — and two reproducible
baseline numbers are recorded.

---

## Phase 4 — Redis holds
`feat/seat-holds`

**4.1 Hold service** — `SET hold:{showId}:{seatId} {userId} NX EX 420`.
Acquire / release / extend / check-owner. Multi-seat holds are all-or-nothing:
acquire in sorted seat order to avoid deadlock, roll back on partial failure.

**Release and extend must be compare-and-delete in a Lua script**, never `GET`
then `DEL`. Between those two round trips a hold can expire and be re-acquired,
and you delete a stranger's hold. It fails rarely — which is what makes it
dangerous.

Rollback is best-effort: if releasing an already-acquired seat fails, it expires
at TTL. State that rather than implying atomicity.

**4.2 Endpoints** — POST hold · DELETE hold · GET remaining TTL.

**4.3 Availability merge** — a seat is unavailable if booked in Postgres **or**
held in Redis. One query path, not two. `availabilityService` owns seat-status
truth; `holdService` must not expose a second availability read.

**4.4 Frontend countdown** — driven by server TTL, never `Date.now()`. Survives
refresh by re-fetching TTL. Expiry clears selection with a clear message.

**4.5 Crash test** — hold seats, `kill -9` the app server, verify auto-release at
TTL. Note the result in the README.

**Done when:** two browser tabs cannot hold the same seat.

---

## Phase 5 — Payment + idempotency
`feat/payments`

Razorpay deferred — a mock provider gives the identical metric with no ngrok.

**5.1 Mock payment service** — `POST /payments/confirm` taking a booking ref and
`payment_event_id`. Configurable success/failure and delay (~30 lines).

**5.2 Idempotency layer** — `payment_events` table, unique constraint on the
provider event ID. Duplicate → early return, zero side effects. The duplicate
response is 200 with the original booking, not a 409 — decided here, not
improvised at implementation time.

**5.3 Confirmation flow** — **commit Postgres first, release the Redis hold
after.** Insert booking rows and mark paid in one transaction; the Redis `DEL`
runs only once that transaction has committed.

Releasing inside the transaction is a correctness bug: a rollback would free the
seat while the payment succeeded. A hold outliving its booking is harmless — the
seat is already booked. A booking outliving its hold is a double-sell.

**5.4 Replay test** — fire the same event 10,000 times **concurrently**, not
sequentially. Sequential proves the constraint exists; concurrent proves it holds
under the race that actually happens.

**Done when:** replaying an event 10,000 times concurrently produces exactly one
booking.

---

## Phase 6 — Reconciliation + live updates
`feat/reconciliation`

Overloaded by design. If it slips, **reconciliation wins, live updates get cut.**

**6.1 Late-payment handling** — payment arrives after the hold expired. Seat still
free → honour it. Seat taken → `refund_pending`. Test with an injected 8-minute
delay (trivial with your mock provider).

**6.2 Reconciliation job** — periodic sweep for paid-but-unconfirmed and
held-but-abandoned states. Idempotent, and safe if one run overlaps its
predecessor.

**6.3 WebSocket broadcast** — seat status changes pushed to viewers of that show.
One room per show. Decide and record who may join: authenticated users only, or
anyone holding the show ID.

**6.4 rAF batching (client)** — buffer incoming updates, flush once per frame.
**Measure it:** updates received vs repaints, before and after. This is the
cheapest defensible frontend number in the build.

**6.5 Optimistic selection** — instant local feedback, rollback on rejection,
correct handling of out-of-order responses.

**Done when:** two tabs stay in sync, a late payment resolves correctly in both
directions, and 6.4 has a measured number.

---

## Phase 7 — Benchmarks
`feat/benchmarks`

**7.1 Load suite** — one committed script per claim: seat contention · webhook
replay · hold throughput · availability query latency.

**7.2 Run properly** — locally against the `docker compose` Postgres and Redis.
Document the machine, the Node/Postgres/Redis versions, and the commit SHA behind
every row.

**7.3a Measure and report** — connection pool exhaustion, missing indexes,
WebSocket memory growth. Report findings; change nothing.

**7.3b Fix only what's approved** — indexes are schema changes, pool sizing is
architecture. Both go through approval before a fix lands. Phase 7 must not
quietly rewrite Phase 1.

**7.4 Results table** — metric · before · after · method · script path · commit.
Only Phase 2 has a genuine before/after; hold throughput and availability latency
are single-point measurements and are labelled as such.

---

## Phase 8 — Docs + ownership
`main`

**8.1 README** — one-line pitch, architecture diagram, benchmark table, setup,
demo link, screenshot/GIF, demo credentials.

**8.2 Architecture doc** — per decision: what you chose, two alternatives, why
you rejected them. This is the canonical list; `BACKLOG.md` P1 points here.

- `UNIQUE` constraint vs `SELECT ... FOR UPDATE` vs advisory locks
- Redis holds vs DB-only holds vs no holds
- Hold TTL length — why 7 minutes and not 3 or 15
- WebSocket vs SSE vs polling for seat updates
- Postgres vs MongoDB for this workload
- What happens on Redis failure (and whether the system stays correct)

**8.3 `BACKLOG.md`** — already in the repo; keep it current. Deliberate scope
decisions read as seniority.

**8.4 Ownership check** — **on a scratch branch**, delete `holdService` and
rewrite from scratch. Then the booking transaction. The branch means a failed
attempt costs nothing. If you can't, keep going until you can.

**8.5 Interrogation** — have Claude Code read the repo and question you on it.
Fail those questions in your room, not in the interview.

---

## Slip plan

**Cut in this order:** live updates → optimistic UI → reconciliation.
**Never cut:** Phase 2's before/after, Phase 5's idempotency test.

If Phase 1 runs long, that time comes out of features — never out of Phase 2.

---

## Working with Claude Code

Give it **one module at a time**, not one phase. "Build Phase 4" produces
something you can't review. "Build the hold service with acquire, release, extend,
and check-owner, using SET NX EX" produces something you can read, test, and own.

After each phase: 20 minutes writing a plain-English summary of what that phase
does and why. That summary is your revision material three months from now.
