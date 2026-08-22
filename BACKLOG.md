# BACKLOG.md

Deferred work for the Concurrent Seat Reservation System.

Everything here was **consciously cut** from the 8-day build, not forgotten. Each
item says why it was cut and what it's worth. Keep this file in the repo root —
it's a positive signal in interviews: it shows you scoped deliberately and know
your own boundaries.

**Rule:** nothing in this file goes on the resume until it's built and measured.

---

## P0 — Do before showing this to anyone

Small, cheap, and their absence looks careless.

- [ ] **Deployed demo link that actually works.** Free tiers sleep. Test the
      cold-start path; if it takes 40s, note it in the README.
- [ ] **Seeded demo data.** A recruiter opening an empty app sees a broken app.
      Ship with movies, shows, and a partially-booked seat map.
- [ ] **Demo account credentials in the README.** Don't make anyone register.
- [x] **README benchmark table filled with YOUR measured numbers.** Done in
      Phase 7.4 and carried into the README: Phase 2's before/after, hold
      throughput, availability latency, replay, broadcast cost and socket
      memory, each with machine, versions, concurrency and commit.
      `docs/phases/phase-7-benchmarks.md`.
- [x] **`loadtest/` scripts committed.** All six k6 scripts —
      `seat-contention.js`, `webhook-replay.js`, `hold-throughput.js`,
      `availability-latency.js`, `ws-fanout.js`, `seat-churn.js` — plus the three
      counting SQL files and every raw k6 summary in `loadtest/results/`.
- [x] **Architecture doc with rejected alternatives** — `docs/architecture.md`,
      six decisions × two rejected alternatives (Phase 8.2).
- [ ] **`.env.example`** with every required variable. No secrets committed.
- [ ] **Screenshot or 30s GIF in the README.** Most people never open the demo.
      **Still open:** the repository contains no image assets at all.
- [ ] **Rotate the Neon database password.** `docs/phases/phase-6-reconciliation.md`
      §9 records that a `NEON_DATABASE_URL` in the local `.env` was printed in
      full, password included, to a session transcript. `.env` is gitignored and
      was never committed, and no code reads that variable — but the credential
      should be rotated in the Neon console before any production use, any
      consumer (Render env vars, local `.env`) updated, and the unused variable
      dropped from `.env` entirely. A manual security task, not implementation
      work; no credential value belongs in this file.

> **Status, 2026-08-22.** The two unticked demo items are unticked on purpose.
> The deployed link serves `main`, which is still the Phase 2 merge (`692ffcf`)
> — Phases 3–7 are unmerged — so it has no holds, no payments, no live updates
> and no client. It was last exercised 2026-08-18 and **was not re-tested in
> Phase 8**, so "actually works" is recorded as unverified rather than assumed.

---

## Phase 7 findings (7.3a) — dispositions

Ruled at the 7.3b gate on 2026-08-22, and re-confirmed in Phase 8. **No fix was
applied for any of them.** Recorded here so a deferred finding stays visible
instead of living only in a phase document. Full evidence:
[`docs/phases/phase-7-benchmarks.md`](docs/phases/phase-7-benchmarks.md) §7.

| | Finding | Ruling | Where it lives now |
|---|---|---|---|
| **F-1** | Own-hold / multi-client seat rendering | **EXPLAINED** in Phase 8 (M1); no fix | P3 below |
| **F-2** | `pg` pool ceiling of 10 | **DEFER** | P2 below |
| **F-3** | Duplicate `booking_seats` indexes | **DEFER** — schema maintenance | P2 below |
| **F-4** | Broadcast cost per watcher | **DEFER / DOCUMENT** — a measured trade-off, not a defect | Known limitations below |
| **F-5** | WebSocket memory growth | **CLOSED** — no growth observed through 1,000 sockets | closed; not reopened |
| **F-6** | Seq scans on `show_prices` and `bookings` | **CLOSED for current scale** | closed; not reopened |

**F-5 and F-6 are closed and stay closed.** No index is to be added merely
because a sequential scan exists: at the measured volumes (`show_prices` 56 rows,
`bookings` 5) a seq scan beats an index, and the whole-show query executed in
0.446 ms at 160 seats and 4.479 ms at 5,000. Revisit only if data volume changes.

---

## P1 — Highest interview value

These change what you can say in a room. Do these before adding any feature.

### Canvas seat map + quadtree
**Why cut:** 1.5 days, and the DOM version demos fine.
**Why it matters:** currently the frontend has no defensible metric. This is the
only item here that fixes that.

- [ ] Scale layout to ~5,000 seats (stadium mode)
- [ ] Canvas renderer replacing the DOM grid — swap the render layer only, the
      selection hook shouldn't change
- [ ] Quadtree for hit-testing on click
- [ ] Viewport culling — draw only what's visible
- [ ] Zoom/pan with a transform stack
- [ ] **Measure:** re-renders per click, click-to-paint, FPS while panning,
      shapes drawn vs total. Compare against the DOM baseline recorded in Phase 3.

> The Phase 3 baseline **was** recorded, so this work is claimable: 5,000
> `SeatButton` re-renders per click in all 10 trials, click-to-paint median
> 79.0 ms (range 33.2–113.4, n=10), on the `npm run seed:stress` dataset. Method
> and caveats are in the README. Compare against those, not against a re-measure.

### Architecture decision doc — **DONE (Phase 8.2)**
**Written: [`docs/architecture.md`](docs/architecture.md).** Six decisions, each
with two rejected alternatives and the evidence behind the choice: the `UNIQUE`
constraint vs `SELECT … FOR UPDATE` vs advisory locks; Redis holds vs DB-only
holds vs none; the 420-second TTL; WebSocket vs SSE vs polling; PostgreSQL vs
MongoDB vs SQLite; and Redis-failure behaviour. Don't duplicate the list here;
one canonical copy or they drift apart.
**Why it matters:** interviewers ask "why not X?", never "what's your architecture?"

### Real payment integration
**Why cut:** needed ngrok + a public URL; the mock gave the same metric.

- [ ] Razorpay test mode behind the existing mock's interface
- [ ] Signature verification on the webhook
- [ ] ngrok for local webhook testing
- [ ] Confirm the idempotency layer needs **zero** changes — if it does, the
      original abstraction was wrong, and that's worth understanding

---

## P2 — Backend depth

Each is a genuine interview topic. Pick by what you want to be asked about.

- [ ] **Virtual waiting room** — queue with position for high-demand shows,
      controlled admission rate. *Metric: admits N/sec steadily vs collapsing at
      X concurrent.*
- [ ] **Partial-hold handling** — user holds 6 seats, pays for 4. Release the
      remainder atomically; don't leak seats.
- [ ] **Group booking constraints** — no orphan single seat left between
      bookings. Constraint-satisfaction problem, real cinema rule.
- [ ] **Dynamic pricing** by tier and occupancy, with price locked at hold time
      so it can't shift mid-checkout.
- [ ] **Cancellation + refund flow** with a policy window.
- [ ] **Multi-instance deployment** — 2-3 Node instances behind a load balancer,
      Redis pub/sub for WebSocket fan-out. Verify holds and bookings stay correct
      across instances.
- [ ] **Rate limiting** on hold creation — one user shouldn't be able to hold a
      whole screen.
- [ ] **Observability** — structured logs, request IDs, p50/p95/p99 timing on the
      booking path.
- [ ] **CI** — deliberately skipped in the 8-day build; verification was run
      locally per module. GitHub Actions running typecheck, tests, and the
      `loadtest/` contention script on every push. *Cheap, and its absence is
      the first thing a reviewer notices.*
- [ ] **F-2 — size the `pg` connection pool deliberately.** `server/src/db/pool.js`
      sets no `max`, so `pg` allows **10**. Sampled during a 200-VU hold load,
      `pg_stat_activity` showed **exactly 10 connections at every sample** while
      Postgres itself allowed **`max_connections=100`**, and most of those
      connections were idle. Hold throughput was flat from 50 to 200 VUs
      (605.3 → 590.9/s) while latency scaled ~4.4× (45.4 → 198.3 ms avg): the
      queue is in Node, not in Postgres. Reported by Phases 2, 5, 6 and 7 and
      changed by none. *Minimum change if ever approved: set `max` in
      `pool.js`.* **This is an architecture and future-scaling decision, not a
      Phase 8 fix** — pool sizing is approval-gated, and a number picked without
      re-measuring against the hosted database would be a guess. Any change must
      be re-benchmarked, because every recorded number above was measured at 10.
- [ ] **F-3 — drop the redundant `booking_seats` index.** Two indexes cover
      identical columns: `booking_seats_show_id_seat_id_idx` (non-unique,
      Phase 1.2) and `booking_seats_show_id_seat_id_key` (**unique**, Phase 2.4's
      guarantee). `pg_stat_user_indexes` shows the planner using the non-unique
      one for the whole-show availability path (4,627 scans) and the unique one
      for the scoped broadcast path (8); **both are maintained on every insert**.
      `002_unique_booking_seats.sql` already recorded this as deliberate and
      deferred. *Minimum change if ever approved: a migration dropping the
      non-unique index.* Schema maintenance, approval-gated — **no migration
      `005` was created and no migration file was touched**. The unique
      constraint is a protected Phase 2 artefact (`CLAUDE.md` §10) and must not
      be touched.

---

## P3 — Frontend depth

- [ ] **Optimistic selection with rollback** (if cut from Phase 6) — including
      correct handling of out-of-order responses
- [x] **rAF-batched WebSocket updates** — built in Phase 6.4 and shipping behind
      `VITE_SEAT_UPDATE_MODE=batched|immediate`, both paths permanent.
      **The measurement is PARKED, and no ratio is published.** What is
      established: message delivery was **lossless in both halves** (4,978
      broadcasts emitted and 4,978 received un-batched; 4,772 and 4,772
      batched), `immediate` performs **exactly one flush per message**, and
      batching demonstrably collapses thousands of messages into tens of flushes
      (4,772 messages → **14** flushes). What is **not** established: the
      display-rate rAF cadence those flushes were taken against — the tab
      measured **24.1 Hz idle** against a 59 Hz panel, so the flush count is not
      a display-rate result and **no flush ratio is claimed anywhere in this
      repository**. Re-attempting it requires an environment *demonstrated* to
      sustain ~59 Hz under the load, measured before and during the run —
      realistically a non-WSL host. `docs/phases/phase-7-benchmarks.md` §5.
- [ ] **F-1 — a hold you own from another client renders as taken until you
      refresh.** The server broadcasts every hold as `held` to the whole room,
      while `GET /seatmap` reports a hold back to its *owner* as `available`. The
      client's compensating guard knows only the holds **this tab** took, so a
      hold owned by your account but taken elsewhere — a second tab, another
      device — renders dark and disabled until the next refetch. Reproduced
      deterministically in Phase 8 (M1); **low severity**: it self-corrects on
      reload, and the owner can still re-take the seat because a same-owner
      re-acquire refreshes the key rather than refusing it.
      **The Phase 6/7 sightings were a test-methodology artifact** — the load
      generator authenticated as `demo@show-rush.dev`, the same account the
      browser was signed in as, so k6's holds arrived as `held` for seats that
      browser had never held. Running the browser on a separate account removes
      the contradiction entirely: socket and refetch agree.
      **This is not a WebSocket/HTTP delivery race.** That hypothesis was tested
      directly and **disproved** — across 25 trials the frame arrived *after* the
      HTTP 201 every time (0/25 before). Do not resurrect it.
      *If ever fixed:* the guard would have to be keyed on the account rather
      than on this tab's own holds — which means the client needs to know which
      holds are its user's, not just its own. Not attempted, and no fix was
      applied in Phase 8.
- [ ] **Refresh-proof countdown** synced to server time via offset estimation,
      never `Date.now()`
- [ ] **Conflict UX** — what the user sees when a seat in their selection gets
      taken. Silent removal is a bug; a blocking modal is hostile.
- [ ] **Seat recommendation** — "best N together": contiguous-run search with a
      centrality score. Small, pure DSA, genuinely useful.
- [ ] **Accessibility on canvas** — canvas is invisible to screen readers.
      Parallel keyboard navigation + ARIA live announcements. Rare; signals care.
- [ ] **Mobile layout** for the seat map — pinch-zoom, touch targets

---

## P4 — Product surface

Deliberately cut. **Adding these does not improve the resume.** Only build them
if you specifically want a fuller demo video.

- [ ] Admin UI (seed script covers this)
- [ ] Reviews and ratings
- [ ] Recommendations
- [ ] Multi-city / multi-cinema
- [ ] Trailers, F&B add-ons, offers and coupons
- [ ] Email/SMS booking confirmations
- [ ] Social login

---

## Known limitations

Be able to state these out loud. Knowing your own gaps reads as seniority;
being surprised by them reads as the opposite.

- **Single instance.** Holds and bookings are correct, but WebSocket updates
  won't fan out across instances without Redis pub/sub.
- **F-4 — live updates cost hold throughput, and the number is known.** Measured
  in Phase 7 on the same hold workload with watchers varied: **~499/s with 0
  watchers · ~373/s with 1 · ~238/s with 50** (−25.2% and −52.4%), hold latency
  54.6 → 75.8 → 117.4 ms avg. One watcher costs a quarter of hold throughput,
  because each seat change pays a scoped query plus a Redis `MGET` once
  regardless of room size; the further drop at 50 is per-socket fan-out. This is
  a **measured architectural trade-off, not a defect** — the hub's early return
  when nobody is watching is doing substantial work. Deferred as documented; no
  change is recommended without deciding what to trade for it.
- **Only Phase 2 is deployed.** `main` and `origin/main` are at `692ffcf`;
  Phases 3–7 are nine unmerged commits on `feat/benchmarks`, and the client has
  never been deployed. Merging and deploying are separate decisions and neither
  has been taken.
- **Benchmarks measured locally**, not on production hardware. The before/after
  ratio is the meaningful part; absolute numbers would differ on a real host.
- **Mock payment provider** (unless P1 is done). Idempotency is real and tested;
  the gateway is not.
- **No refunds.** The reconciliation job marks late payments for refund but
  doesn't execute one.
- **Redis is a hard dependency.** If Redis is down, holds fail — though Postgres
  still guarantees no double-booking, so the system degrades to slow-but-correct.
  Worth being able to explain that distinction.

---

## Ownership checklist

Not features — the thing that decides whether this project helps or hurts.

- [ ] Deleted and rewrote `holdService` from scratch, without reference
- [ ] Deleted and rewrote the booking transaction from scratch
- [ ] Can explain the naive race condition and why it happens under READ COMMITTED
- [ ] Can derive the interval-overlap condition on a whiteboard
- [ ] Can explain why the unique constraint is the guarantee and Redis is the
      optimization
- [ ] Had Claude Code interrogate me on the repo and answered without looking
- [ ] Can name one thing I deliberately did **not** build, and why
