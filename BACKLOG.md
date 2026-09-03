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

- [x] **Deployed demo link that actually works.** Free tiers sleep. Test the
      cold-start path; if it takes 40s, note it in the README. Re-verified
      2026-08-31: `/health` **200 in 23.6 s** cold — inside the 23.2–27.0 s the
      README already documents — and 0.20 s warm. `/api/movies`,
      `/api/movies/:id/shows` and `/api/shows/:id/seatmap` all answer; an unknown
      show is a 404; the demo account logs in with 200 and a wrong password is
      refused with 401. **It serves the Phase 2 build**, so it demonstrates the
      catalogue rather than this repository — see the status note below.
- [x] **Seeded demo data.** A recruiter opening an empty app sees a broken app.
      Ship with movies, shows, and a partially-booked seat map. Verified on the
      deployed database 2026-08-31: **5 movies**, 4 shows on movie 1, and show 1
      returning **160 seats, 9 booked / 151 available** across 64 silver, 64 gold
      and 32 platinum — a genuinely partially-booked map, not an empty one.
- [x] **Demo account credentials in the README.** Don't make anyone register.
      Present near the top of the README, and re-exercised against the deployed
      Phase 2 build on 2026-08-31: login returns 200 with the user and a token,
      no `password_hash` in the payload, and a wrong password returns 401.
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
- [x] **`.env.example`** with every required variable. No secrets committed.
      Checked variable by variable against what the code actually reads: all
      thirteen in `config/env.js` and all three `VITE_` variables the client
      reads are listed, each with a comment. Every sensitive value —
      `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` — ships empty.
- [x] **Screenshot or 30s GIF in the README.** Most people never open the demo.
      `docs/images/seat-map.jpg` — the canvas seat map with its three price
      tiers, dimmed booked seats and aisles, captured 2026-08-31 from the
      production client build served by `vite preview` against a local API.
      A still, not a GIF: it shows what the app looks like, not what it does.
      It is also a screenshot of the **local** stack — the deployed link has no
      client — and the caption says so rather than implying otherwise.
- [ ] **Rotate the Neon database password.** `docs/phases/phase-6-reconciliation.md`
      §9 records that a `NEON_DATABASE_URL` in the local `.env` was printed in
      full, password included, to a session transcript. `.env` is gitignored and
      was never committed, and no code reads that variable — but the credential
      should be rotated in the Neon console before any production use, any
      consumer (Render env vars, local `.env`) updated, and the unused variable
      dropped from `.env` entirely. A manual security task, not implementation
      work; no credential value belongs in this file.

> **Status, 2026-08-31.** The demo items above are ticked against **what is
> actually deployed**, which is not this codebase. Phases 3–8 and the backlog
> work are merged into local `main` (`9aab673`, a `--no-ff` merge), but
> **nothing has been pushed**: `origin/main` is still the Phase 2 merge
> (`692ffcf`), so the deployed link serves Phase 2 — no holds, no payments, no
> live updates, and no client at all.
>
> So read those two ticks narrowly. The link works, the cold start is inside the
> documented range, and the data is seeded and partially booked — twice measured,
> 24.2 s and 23.6 s cold on two separate runs. What is **not** true is that the
> demo shows the system this repository describes. That needs a push and a
> deploy, which are separate decisions and have not been taken.

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

### Canvas seat map + quadtree — **DONE**
**Why cut:** 1.5 days, and the DOM version demos fine.
**Why it matters:** currently the frontend has no defensible metric. This is the
only item here that fixes that.
**Built and measured.** Both renderers ship permanently behind
`VITE_SEAT_RENDERER=canvas|dom`, defaulting to canvas — the DOM grid is the
baseline the canvas is measured against, and it is the only accessible path.
Click-to-paint at 5,000 seats went from a median of **79.0 ms to 36.9 ms**
(n=10 each), and the 5,000 `SeatButton` re-renders per click became zero
components. `docs/phases/phase-9-improvements.md`.

- [x] Scale layout to ~5,000 seats (stadium mode)
- [x] Canvas renderer replacing the DOM grid — swap the render layer only, the
      selection hook shouldn't change — `useSeatSelection.js` diff is empty
- [x] Quadtree for hit-testing on click — 1,329 nodes, depth 5, hand-written
- [x] Viewport culling — draw only what's visible — 6.2 % of 5,000 drawn at
      scale 1.65, 100 % at the fit view where nothing can be culled
- [x] Zoom/pan with a transform stack
- [ ] **Measure — partly done.** Re-renders per click, click-to-paint and shapes
      drawn vs total are measured against the Phase 3 baseline. **FPS while
      panning is NOT MEASURED for the shipped draw loop** — the pan-rate table
      was taken before the draw loop was changed to batch seats by appearance,
      and the measuring tab became unavailable before it could be re-run. No
      frame-rate claim is made anywhere. This box stays unticked until it is.
      **Re-attempted 2026-08-31 and refused at the gate**: in a browser driven
      by the automation extension the tab reports `visibilityState: "hidden"`
      and `requestAnimationFrame` is suspended outright — a bounded probe
      counted **0 frames in 2 s**, and the canvas had drawn nothing. Any number
      taken there would measure the suspension. This needs a foreground,
      human-driven window; it is not obtainable from an automated session.

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
- [x] **Cancellation + refund flow** with a policy window.
      `POST /api/bookings/:ref/cancel`, owner-only, cancelling a booking **whole**
      — there is no partial cancellation. A `pending` booking becomes
      `cancelled`; a `paid` one becomes `refund_pending`. The window is measured
      against `shows.starts_at`, default `CANCELLATION_WINDOW_MINUTES=120`, and
      exactly on the boundary is closed.
      The seats are archived to `released_booking_seats` with the new reason
      `'cancelled'` (migration `005`, which is what `004` anticipated when it
      said a second reason would be a migration) and their `booking_seats` rows
      deleted — a status change alone would leave a seat that reads `available`
      and still raises 23505, exactly as Module 6.2 records.
      Cancellation, payment and the sweep all take `FOR UPDATE` on the same
      `bookings` row, so the three serialise rather than race; the archive,
      delete and status SQL is **deliberately duplicated** from
      `reconcileService` rather than shared, because a sweep able to cancel a
      paid booking would be a bug with a refund attached.
      **NOTHING IS REFUNDED.** There is no payment provider (a real one is P1,
      deliberately not built), so `refund_pending` records that a refund is owed
      and never that one happened. It now has two causes — this, and Module
      6.1's late payment — told apart by `released_booking_seats.reason` rather
      than by the status. **No client screen calls the endpoint**, and no metric
      is claimed; the item names none. The policy is pure and covered by
      **12 unit tests**; the transaction is verified by scripted HTTP and SQL.
- [x] **Multi-instance deployment** — three Node instances behind nginx, one
      Redis pub/sub channel for WebSocket fan-out, behind a `multi` compose
      profile. **Local only: `render.yaml` is untouched and the deployed service
      is still one process.** Correctness verified rather than assumed —
      **exactly one frame** per watcher per change, including a watcher on the
      same instance as the writer, where the origin publishing *and* delivering
      locally would have shown as two. Holds, releases and bookings all fan out;
      show isolation holds; no sticky sessions are needed, because the socket is
      server-to-client only and its show is fixed at upgrade time. Redis down
      degrades to local-only: instances stay up, holds fail closed, Postgres
      still refuses the second sale, and delivery recovers when Redis returns.
      *Measured, at the Phase 7 §7.3a configuration:* hold throughput **393.4/s**
      single instance on the host with this code, **361.7/s** containerised,
      **340.8/s** across three instances behind nginx, against the **499.5/s**
      Phase 7 baseline on the pre-change code. **Three instances did not raise
      throughput** — the workload is bound by the shared Postgres and Redis, so
      this buys availability and correct fan-out, not speed.
      `docs/phases/phase-9-improvements.md`.
- [x] **Rate limiting** on hold creation — one user shouldn't be able to hold a
      whole screen. A fixed window counted **in Redis, per user**, default 30
      requests per 60 s, `429 RATE_LIMITED` with `Retry-After` when exceeded.
      Redis rather than in-process because of the multi-instance work above: an
      in-process counter would grant the limit *per instance*. Verified that the
      budget is **shared across all three instances** (30 accepted, not 90),
      that a second account has its own budget, and that releases are never
      limited. Fails open if Redis is unreachable, where holds already fail
      closed with 503. `HOLD_RATE_LIMIT=0` disables it, and **every hold
      benchmark must set that** — otherwise the run measures the limiter.
      No metric is claimed; the item names none.
      `docs/phases/phase-9-improvements.md`.
- [x] **Observability** — structured logs, request IDs, p50/p95/p99 timing on the
      booking path. One JSON line per request carrying a request id, the **route
      pattern** rather than the URL, status and duration; `X-Request-Id` honoured
      when well-formed and echoed back; `GET /metrics` serving count, min, max,
      mean and bucket-resolution percentiles per route, **404 in production**.
      No dependency added — `node:crypto`, `console.log` and fixed-bucket
      histograms, so memory stays constant under load. Measured overhead on the
      hold path: **none detectable** against run-to-run noise. Per-process only,
      resets on restart, and the WebSocket path is uninstrumented.
      `docs/phases/phase-9-improvements.md`.
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

- [x] **Optimistic selection with rollback** (if cut from Phase 6) — including
      correct handling of out-of-order responses. **It was not cut**: Module 6.5
      built it. The click applies immediately, the seat renders as pending until
      the server agrees, and a refusal rolls it back. Out-of-order responses are
      handled by a per-seat sequence counter in `useSeatSelection` — an answer
      may only act on its own seat, and only while it is still the newest word
      on it, so a rollback for a click the visitor has since undone cannot undo
      the one they meant.
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
- [x] **Refresh-proof countdown** synced to server time via offset estimation,
      never `Date.now()`. Refresh-proof already: the seat ids come back from
      `sessionStorage` and their validity from the server, which is also where
      the remaining seconds come from. What was added is the offset: the
      server's TTL is pinned to a `performance.now()` reading and every tick
      recomputes the remainder from that pair, instead of subtracting one per
      timer. Timers always fire late, and subtraction kept the error — always in
      the direction that flattered the client. `performance.now()` cannot be
      moved by NTP, a clock change or a DST jump; `Date.now()` appears nowhere
      in the path.
- [x] **Conflict UX** — what the user sees when a seat in their selection gets
      taken. Silent removal is a bug; a blocking modal is hostile. The seat was
      already dropped from the total the moment its status changed — correct,
      and silent, which was the bug. `useSeatSelection` now names those seats,
      the page announces them by row and number in a dismissible `role="status"`
      line, and forgets them only after they have been named. Not a dialog: the
      visitor keeps whatever they were doing.
      **Seats this tab holds, and seats still confirming, are excluded** — the
      room is told about every hold, so this tab's own broadcast can arrive
      before its held list catches up, and announcing that would accuse the
      visitor of losing a seat they are holding.
- [x] **Seat recommendation** — "best N together": contiguous-run search with a
      centrality score. Small, pure DSA, genuinely useful.
      `client/src/seatmap/recommend.js`, pure and with no React or DOM in it, so
      it is tested exhaustively without a browser — **11 unit tests**. Runs are
      maximal sequences of consecutive *seat numbers* within a row, never array
      neighbours, so a hole in a row cannot produce a "run" the group would have
      to climb over. Every window of the requested size is scored on distance
      from the ideal depth (0.65 of the way back) plus distance from the row's
      own centre, and the best is applied through the same `toggle` a click
      uses — so it takes holds and obeys the six-seat ceiling like any other
      selection. Verified in the browser on Audi 1: asked for 2, returned
      **G8–G9** — row G is two thirds back of ten rows, 8–9 the centre of
      sixteen.
- [x] **Accessibility on canvas** — canvas is invisible to screen readers.
      Parallel keyboard navigation + ARIA live announcements. Rare; signals care.
      The canvas takes focus, `role="application"` so the arrows reach it rather
      than the screen reader's own navigation, and a cursor moves over the same
      geometry the pointer hit-tests — reusing the hover ref, so the draw loop
      was not touched. Arrows move, Home and End reach the ends of a row, Enter
      and Space toggle, and the view follows a cursor that walks off-screen.
      Every move is announced in a visually-hidden `aria-live="polite"` region.
      Verified in the browser: focus announces the cursor, blur clears it,
      arrows clamp at the edges, Enter selected B1 (2 seats → 3, ₹640 → ₹840)
      and deselected it again, and Space on a booked seat did nothing.
      **This is a parallel, not an equivalent.** There is one focusable element
      rather than one per seat, so a screen reader's element-by-element browsing
      still finds nothing to walk; `VITE_SEAT_RENDERER=dom` remains the fuller
      path. **Not tested with an actual screen reader** — only the ARIA surface
      and keyboard behaviour were verified.
- [ ] **Mobile layout** for the seat map — pinch-zoom, touch targets.
      **Written, then removed again rather than shipped unverified.** A
      two-pointer pinch-to-zoom about the midpoint, a second finger cancelling
      any drag or tap in progress, and `@media (pointer: coarse)` targets of
      40px for seats and 44px for buttons were all implemented — and none of it
      could be exercised, because this environment has no touch input and
      synthetic pointer events would only prove the code calls itself. Untested
      gesture handling on the one path that cannot be checked here was not worth
      carrying, so it was taken back out; the canvas is still single-pointer pan
      and wheel zoom. The approach is recorded in commit `131f3a2` if it is
      wanted again, and needs a real device to verify.

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

- **Multi-instance works locally; only a single instance is deployed.**
  WebSocket updates fan out across processes over Redis pub/sub, verified at
  exactly one frame per watcher per change, and three instances run behind nginx
  under `docker compose --profile multi`. `render.yaml` is untouched, so the
  deployed service is still one process. Without Redis the fan-out degrades to
  local-only — the instance that made the change still tells its own sockets,
  other instances hear nothing.
- **F-4 — live updates cost hold throughput, and the number is known.** Measured
  in Phase 7 on the same hold workload with watchers varied: **~499/s with 0
  watchers · ~373/s with 1 · ~238/s with 50** (−25.2% and −52.4%), hold latency
  54.6 → 75.8 → 117.4 ms avg. One watcher costs a quarter of hold throughput,
  because each seat change pays a scoped query plus a Redis `MGET` once
  regardless of room size; the further drop at 50 is per-socket fan-out. This is
  a **measured architectural trade-off, not a defect** — the hub's early return
  when nobody is watching was doing substantial work. Deferred as documented; no
  change is recommended without deciding what to trade for it.
  **Superseded in part by the multi-instance work above: that early return no
  longer exists**, because an instance cannot know whether another instance has
  a watcher. The three figures here were measured with it in place and are kept
  as the record of that code. What replaced it was measured at 0 watchers only
  (393.4/s on the same host topology); **the watcher-varied table has not been
  re-run against the current code.**
- **Only Phase 2 is deployed.** Merged, not shipped: local `main` is at
  `9aab673` and carries Phases 3–8 plus the backlog work, while `origin/main`
  is still `692ffcf`, which is what the demo serves. The client has never been
  deployed — `render.yaml` builds and starts the server only. Deploying remains
  a separate decision that has not been taken; when it is, `render.yaml` now
  applies migrations `003` and `004` before the app starts, and leaves the
  reconciliation sweep disabled until it has been verified against Neon.
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
