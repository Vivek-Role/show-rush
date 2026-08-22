# Phase 8 — Docs + ownership · close-out

**Status:** M0–M5 COMPLETE. **M6 not started** (user-initiated only). **M7
PARTIALLY CONDUCTED** — see §8. **H1 outstanding** (user performs).
**Branch:** `feat/benchmarks` @ `59778a5` — **not committed, not merged, not
pushed, not deployed.**
**Source of truth:** [`phase-8-plan.md`](phase-8-plan.md), `PLAN.md` §Phase 8,
`BACKLOG.md`, [`phase-7-benchmarks.md`](phase-7-benchmarks.md)
**Rules:** `CLAUDE.md` — not restated here
**Close-out written:** 2026-08-22, after the final verification pass in §8

---

## 1. What Phase 8 was

A documentation and diagnosis phase. It changed **no application code, no
schema, no dependencies and no configuration** — the same structural guarantee
Phase 7 had, and the reason "Phase 8 must not quietly rewrite Phases 1–7" is
true here rather than merely promised.

Three files were written or changed in total: `README.md`, `docs/architecture.md`
(new) and `BACKLOG.md`. Everything else Phase 8 produced is a finding.

| Module | Type | Outcome |
|---|---|---|
| **M0** integration review | Diagnosis | COMPLETE — read-only, no merge |
| **M1** F-1 diagnosis | Diagnosis | COMPLETE — **EXPLAINED**, no fix |
| **M2** rAF disposition | Decision | COMPLETE — **PARKED**, no file change |
| **M3** README rewrite (8.1) | Docs | COMPLETE — fact-checked |
| **M4** architecture doc (8.2) | Docs | COMPLETE — `docs/architecture.md` |
| **M5** `BACKLOG.md` update (8.3) | Docs | COMPLETE |
| **M6** ownership rewrite (8.4) | Scratch branch | **NOT STARTED** — user-initiated only |
| **M7** interrogation (8.5) | Review | **PARTIALLY CONDUCTED** — 3 of ~40 questions answered; see §8 |
| **H1** Neon credential rotation | Housekeeping | **OUTSTANDING** — user performs |

---

## 2. M0 — Integration review (read-only, no merge)

**Branch ancestry is strictly linear.** `main` is a direct ancestor of
`feat/benchmarks`; the merge base *is* `main` itself.

```
main...feat/benchmarks   =  0 / 9      (main-only / branch-only)
main...origin/main       =  0 / 0
merge-base               =  692ffcf   (= main)
```

`main` and `origin/main` are both **`692ffcf`** — the Phase 2 merge. The nine
unmerged commits are Phases 3–7:

```
59778a5  feat: add Phase 7 benchmarks                       Phase 7
7902b8a  feat: add reconciliation and live seat updates      Phase 6
00ca1f7  feat: add mock payments with idempotent replay      Phase 5
d76fa5f  feat: add seat holds with Redis TTL                 Phase 4
a9c8283  feat: add Redis seat hold service                   Phase 4
681ea8a  feat: complete seat map booking flow                Phase 3
727c38b  feat: add seat selection and pricing                Phase 3
1d5d712  feat: add interactive seat map                      Phase 3
f51e75f  feat: add React app shell and cookie auth           Phase 3
```

90 files, +19,379 / −42, additive throughout: the `client/` workspace, migrations
`003` and `004`, `holdService` / `paymentService` / `reconcileService` /
`realtime/hub.js`, the `loadtest/` suite with 22 result files, and phase docs
3–7.

**No integration conflicts are possible.** The history is linear and
fast-forwardable, the working tree was clean apart from the untracked Phase 8
plan, there were no stash entries and no in-progress merge/rebase/cherry-pick
state, and every `CLAUDE.md` §10 carve-out survives on the branch —
`BOOKING_MODE=naive` with its production refusal, migration `002`'s unique
constraint, and no migration `005`.

**A merge remains a separate, explicit decision.** M0 produced a review and
nothing else. Approving M0 did not authorise a merge, and none was performed.

**Deployment risks are separate again, and were not resolved by M0.** They are
properties of deploying, not of merging:

| | Risk |
|---|---|
| R-1 | `render.yaml`'s `buildCommand` is `npm ci` only — **nothing applies migrations**. Phase 5/6 code requires `payment_events` and `released_booking_seats` on Neon |
| R-2 | `RECONCILE_INTERVAL_SECONDS` defaults to **60** and `index.js` starts the sweep unconditionally — a deployed `main` would begin mutating booking rows on Neon every 60 s |
| R-3 | `render.yaml` is byte-identical on both branches: one Node service, no client build. Merging adds the client to the repository, **not to the demo** |
| R-4 | `CLIENT_ORIGIN` unset on Render blocks browser clients by CORS (non-fatal, logged) |
| R-5 | Phase 6/7 code has **never run against Neon or Upstash** — WebSocket upgrade through Render's proxy and the Redis Lua paths are NOT VERIFIED there |
| R-6 | Render auto-deploy state was **not queried** — NOT VERIFIED. `render.yaml` names no `autoDeploy` key, so the platform default most likely applies |

**Recommended strategy, not executed:** `git merge --no-ff feat/benchmarks`,
preserving all nine commits — matching the existing pattern on `main`
(`866c682`, `692ffcf` are both explicit merge commits). Not squashed; the
per-phase commits are the audit trail behind every measurement. Merging **after**
the Phase 8 documentation commit avoids `main` ever carrying the stale README.

---

## 3. M1 — F-1 diagnosis

**Final ruling: EXPLAINED** — and, unusually for this finding, also
**reproducible**: Phase 8 produced a procedure that triggers it on demand.

**Mechanism.** The server broadcasts every hold viewer-agnostically as `held`
(`hub.js` passes no `forUserId`), while `GET /api/shows/:id/seatmap` reports a
hold back to *its owner* as `available` (`availabilityService.mergeHolds`). The
client's compensating guard at `SeatMapPage.jsx:133` knows only the holds **this
tab** took. **The guard is scoped per client; the server's exemption is scoped
per account.** Any hold owned by the viewer's account but taken by a different
client therefore renders dark and disabled, and turns green again on reload.

**The Phase 6/7 symptom was a test-methodology artifact.** `seat-churn.js`
authenticates as `demo@show-rush.dev` — the same account the browser was signed
in as during those observations. k6's holds arrived as `held` for seats that
browser had never held, while a refetch reported them `available`. That is the
observed contradiction, exactly.

**The two-account test.** Browser on a freshly registered account
(`m1-browser@show-rush.dev`, user 2); load generator left on `demo` (user 1);
`loadtest/seat-churn.js` unmodified at 2 VUs × 2 seats; show 20; console and
DevTools observation only. Three simultaneous three-way reads while k6's holds
were live:

| Seat | DOM (browser, user 2) | REST as user 2 | REST as demo (user 1 = holder) | REST anon |
|---|---|---|---|---|
| 164–167 | `held` | **`held`** | **`available`** | `held` |

**With separate accounts the socket and a refetch agree — the symptom does not
occur.** For the holder's own account the server reports `available` on refetch
while having just broadcast `held`.

**The residual product behaviour, reproduced deterministically.** A hold taken
for user 2 by a *separate client* (bearer token, not routed through
`useSeatHolds`) on seat 220:

```
POST /api/shows/20/holds  → 201 in 20.0 ms   (owner = user 2)
observer socket           → {id:"220", status:"held"}       t = 270191.0
DOM                       → data-status "available" → "held"  t = 271671.9
rendered                  → status=held, disabled=true
REST for that same viewer → "available"
Redis                     → hold:20:220  owner=2  ttl=390
after reload              → status=available, disabled=false  (hold still live)
```

**Low severity:** it self-corrects on reload, and the owner can still re-take the
seat — a same-owner re-acquire refreshes the key rather than refusing it,
verified by clicking the seat and watching the hold return at 7:00.

**The original WebSocket/HTTP race is DISPROVED and must not be revived.**
Phase 7 measured **0 of 25** frames arriving before their HTTP 201 (median
+1.91 ms *after*). M1 reconfirmed the ordering on its own runs (frames at +0.6
and +0.7 ms after the response) and observed the DOM flip arriving ~1.5 s after
the frame via the fallback flush, with the hold response long resolved.

**No application fix was applied.** No file under `server/` or `client/` was
modified; the only instrumentation was temporary, in-page console code
(observer socket, `MutationObserver`, `fetch` wrapper, rAF counter) that died
with its tab. Repository instrumentation was never written — the escalation gate
was not reached.

**Test-data note:** M1 registered `m1-browser@show-rush.dev` (user id 2) in the
**local** dev database and released every hold it took (`dbsize=0` afterwards).
No bookings, payments or `released_booking_seats` rows were created.

---

## 4. M2 — rAF disposition

**PARKED — an unresolved measurement limitation. No flush-ratio headline, no
invented number.**

Established, and stated in both `README.md` and
[`phase-7-benchmarks.md`](phase-7-benchmarks.md) §5:

- **Zero message loss on both halves.** `immediate`: **4,978 broadcasts emitted,
  4,978 received**. `batched`: **4,772 emitted, 4,772 received**.
- **`immediate` performs exactly one flush per message** — 4,978 flushes for
  4,978 messages.
- **Batching demonstrably collapses thousands of messages into tens of
  flushes** — **4,772 messages → 14 flushes**.

Not established: the rAF cadence those 14 flushes were taken against. The tab
measured **24.1 Hz idle against a 59 Hz panel**, with an implied ~0.7 Hz flush
cadence under load, and GPU acceleration, Energy Saver, Memory Saver, host load
and stray processes were all ruled out without explaining it.

**Therefore no ratio is published.** At display rate it would be roughly 4:1; at
the observed cadence roughly 380:1. Both cannot be true, so neither is claimed —
as a ratio, a range or an estimate. M2 produced **no file change**, because the
repository already worded this correctly.

Prerequisite for any future attempt, not attempted here: an environment
*demonstrated* to sustain ~59 Hz under a ~238 msg/s arrival rate, measured
before and during the run.

---

## 5. M3 — README rewrite (8.1)

**COMPLETE**, +186 / −20, 611 → 778 lines.

Fixed: the status header (was "Phase 3 complete on `feat/seat-map`"); the two
false "Known limitations" bullets claiming holds and payment do not exist; the
demo section, which now states that the link serves `main` — the Phase 2
codebase — and that holds, payments, the sweep, the WebSocket and the client are
**not deployed**, plus that the link and credentials were last exercised
2026-08-18 and were not re-tested in Phase 8. Added: an Architecture section with
a Mermaid diagram derived from the code; API documentation for Holds, Payments
and Live updates; the viewer-aware/viewer-agnostic distinction; corrected seat
`status` values.

**Fact-check result: PASS.** Every file link and in-page anchor resolves. Every
new API claim was traced to source (`routes/shows.js`, `routes/payments.js`,
`holdService.js`, `availabilityService.js`, `hub.js`, `reconcileService.js`,
migrations `002`/`003`). **A diff of every removed line confirmed that not one
contained a number, a method or a caveat** — all 20 were outdated status prose.
Phase 2's before/after, the Phase 3 rendering baseline, the Phase 6 hidden-tab
warning, the Phase 7 results table and "Still not measured" all survive intact,
with their methods.

**Could not be added honestly:** the screenshot/GIF `PLAN.md` 8.1 asks for — the
repository contains no image assets and fabricating one is not an option — and a
verified demo link, since testing production was out of scope. Both remain open
in `BACKLOG.md` P0.

---

## 6. M4 — Architecture doc (8.2)

**COMPLETE** — [`docs/architecture.md`](../architecture.md), 555 lines,
**six decisions × two rejected alternatives = twelve**, verified structurally:

| # | Decision | Rejected |
|---|---|---|
| 1 | `UNIQUE (show_id, seat_id)` + transaction | `SELECT … FOR UPDATE` · advisory locks |
| 2 | Redis holds, `SET NX EX 420` | DB-only holds · no hold layer |
| 3 | 420-second TTL | ~3-minute TTL · ~15-minute or configurable TTL |
| 4 | WebSocket, one room per show | Server-Sent Events · polling |
| 5 | PostgreSQL + `pg` raw SQL | MongoDB · SQLite |
| 6 | Holds fail closed, reads degrade open | Postgres hold fallback · fail open |

Each carries Decision · Why · How it works here · two rejections with reasons ·
Evidence · Limitation. Measurements are cited, not re-derived, and are framed as
*measured in this benchmark* rather than as capacity.

**Two honesty notes are recorded in the document itself**, per the phase rule
that an undocumented reason must be declared rather than invented: the
repository **does not record why 420 seconds was chosen** over 180 or 900 —
`PLAN.md` specifies it as an input and 8.2 poses it as a question — so only the
constraints it must satisfy are given; and **no comparative evaluation of
MongoDB was ever performed** in this project.

---

## 7. M5 — `BACKLOG.md` update (8.3)

**COMPLETE**, +134 / −14, 162 → 281 lines. Structure, terminology and priority
ordering preserved; no unrelated item's priority changed; no historical
information deleted.

A new **"Phase 7 findings (7.3a) — dispositions"** section records all six
rulings verbatim from the 7.3b gate:

| | Finding | Ruling | Where it lives |
|---|---|---|---|
| **F-1** | Own-hold / multi-client rendering | **EXPLAINED** in Phase 8; no fix | P3 |
| **F-2** | `pg` pool ceiling of 10 | **DEFER** | P2 |
| **F-3** | Duplicate `booking_seats` indexes | **DEFER** — schema maintenance | P2 |
| **F-4** | Broadcast cost per watcher | **DEFER / DOCUMENT** — trade-off, not defect | Known limitations |
| **F-5** | WebSocket memory growth | **CLOSED** | closed, not reopened |
| **F-6** | Seq scans on `show_prices` / `bookings` | **CLOSED for current scale** | closed, not reopened |

- **F-2** carries its evidence: exactly 10 connections at every sample under 200
  VUs against `max_connections=100`; throughput flat 605.3 → 590.9/s while
  latency scaled ~4.4× (45.4 → 198.3 ms). Recorded as an architecture and
  future-scaling item, **not a Phase 8 fix**, and any change must be
  re-benchmarked because every number was measured at 10.
- **F-3** carries the planner evidence (4,627 scans on the non-unique index, 8 on
  the unique one, both maintained on every insert). **No migration `005` was
  created and no migration file was touched.**
- **F-4** is recorded under Known limitations as a **measured architectural
  trade-off, not a defect**: ~499/s with 0 watchers, ~373/s with 1, ~238/s with
  50 (−25.2%, −52.4%).
- **F-5 and F-6 remain closed** and gained no work items — the file states
  explicitly that no index is to be added merely because a sequential scan
  exists.
- **rAF** is recorded as built-and-parked per M2, with lossless delivery, the
  4,772 → 14 collapse, the unestablished cadence and **no ratio**.
- **F-1** is recorded per M1, including that the disproved race must not be
  resurrected.
- P0 items ticked where Phase 7/8 completed them: benchmark table, `loadtest/`
  scripts (six k6 scripts plus three counting SQL files), architecture doc. The
  demo-link and screenshot items stay **unticked on purpose**, with a dated note
  explaining why.

**Neon credential rotation (H1) is tracked appropriately** — a P0 item naming
[`phase-6-reconciliation.md`](phase-6-reconciliation.md) §9's disclosure and the
three required actions (rotate in the Neon console, update consumers, drop the
unused variable from `.env`). **No credential value appears anywhere**, `.env`
was not touched, and nothing was rotated: that is the user's task, not Claude's.

---

## 8. M7 — Interrogation (8.5): **PARTIALLY CONDUCTED**

**M7 — Partially conducted; core concurrency understanding demonstrated. Full
interrogation not completed. Interview readiness not formally assessed.**

A first attempt was opened and approved before any answer was given; that attempt
produced nothing and is recorded as such. The interrogation was then genuinely
conducted, and stopped by the user after **four questions asked and three
answered**, all within Area 1 (booking concurrency). Areas 2–9 were never put.

### Demonstrated — from answers actually given

| Q | Topic | Result |
|---|---|---|
| 1 | Why the `UNIQUE` constraint is the guarantee, not the pre-check | **Correct**, with corrections |
| 2 | What the losing `INSERT` does while the winner is uncommitted | **Correct and precise** |
| 3 | What 379 · 305 · 379 → 0 · 0 · 0 proves and does not prove | **Good**, one gap |
| 4 | How the zero is shown to be real load, and what the third run isolates | **Asked, not answered** |

- **Q1.** Identified that the pre-check and the insert are not atomic, that two
  requests can both pass the check, and that the unique index is enforced where
  state is persisted; walked the `23505` → `409` path correctly. Three
  corrections were issued: the mechanism under `READ COMMITTED` was described but
  not named (the `SELECT` takes no locks and sees only rows committed at
  statement start); "no matter how many application servers" overstates the
  boundary — the guarantee is one database, and would hold only within a shard;
  and the pre-check was framed as pure UX, missing that `assertSeatsAvailable`
  passes the booking user's id and is therefore also what enforces *another
  user's Redis hold blocks a booking while the caller's own hold does not*.
- **Q2.** Answered unprompted and correctly: the second `INSERT` **blocks** on
  the in-progress index entry rather than failing immediately, waits for the
  first transaction to resolve, then raises `23505` if it committed or succeeds
  if it rolled back — with the index named as the serialisation point.
- **Q3.** Defended the three-figure before-number, refused to over-claim beyond
  the measured configuration, and identified why the naive side had to be run at
  all. Incomplete on the asymmetry: the before is stochastic because a race is,
  while the after cannot vary, so `0` is not a sample from a distribution.
- **Q4.** Unanswered — recorded as **not answered**, not as failed.

### Inferred — from the repository, NOT from answers given

Explicitly labelled inferred, and not evidence of recall:

- **Likely strongest:** booking concurrency (the one area actually demonstrated),
  and measurement honesty — inferred from artefacts the user directed: three-run
  ranges rather than single figures, `dropped_iterations` and 5xx recorded beside
  every zero, disclosure of a discarded naive run and a discarded memory
  measurement, the refusal to publish an rAF ratio, and `BOOKING_MODE=naive` kept
  permanently so the before-number stays reproducible.
- **Likely weakest:** F-1, which was diagnosed by Claude in M1 rather than
  reasoned through by the user; the arguments inside `docs/architecture.md`,
  which Claude authored under direction and which therefore evidence the
  repository rather than the user's recall; the 420-second TTL, where the
  repository records no reason and the honest answer must be delivered as such;
  performance interpretation, where flat throughput at a pool of 10 is a
  queueing result and must not be narrated as capacity; and the rAF parking
  rationale.
- **Concepts to revise:** `READ COMMITTED` snapshot semantics and index-entry
  blocking, named rather than gestured at; commit-Postgres-then-release-Redis and
  why the reverse is a correctness bug; why cancellation deletes and archives
  seat rows instead of flipping a status; viewer-agnostic broadcast versus
  viewer-aware REST and the cost of changing that; what 499 → 373 → 238/s does
  and does not imply; and one defensible sentence each on F-2, F-3 and F-4 being
  deferred rather than fixed.
- **Interview readiness: NOT FORMALLY ASSESSED.** Three of roughly forty
  questions is not a basis for a verdict, and none was manufactured.

### What remains owed

**`PLAN.md` 8.5 is partially satisfied only.** Areas 2–9 — Redis holds and TTL,
payments and idempotency, reconciliation, WebSockets and broadcast cost,
performance and the pool, rAF, F-1, end-to-end architecture and engineering
judgement — have never been put to the user aloud. The material to run them
against is complete: `README.md`, `docs/architecture.md` and `BACKLOG.md` now
describe what actually exists.

**`BACKLOG.md`'s Ownership checklist stays unticked**, correctly. No
`holdService` or booking-transaction rewrite was attempted — M6 is user-initiated
only and was never started — and "had Claude Code interrogate me on the repo and
answered without looking" is not satisfied by three questions in one area.

---

## 9. Verification — final read-only pass

Run at close-out time, 2026-08-22. **Labels: PASS / NOT RUN / NOT VERIFIED.**

| Check | Result |
|---|---|
| Working tree | **PASS** — `M BACKLOG.md`, `M README.md`, `?? docs/architecture.md`, `?? docs/phases/phase-8-plan.md` |
| Tracked changes outside `README.md` / `BACKLOG.md` | **PASS** — none |
| `server/**`, `client/**` | **PASS** — untouched; no application-code change in the entire phase |
| `server/migrations/**` | **PASS** — untouched; still `001`–`004`, no `005` |
| `package.json`, `package-lock.json`, `server/package.json`, `client/package.json` | **PASS** — zero changes; no dependency added, removed or upgraded |
| `PLAN.md`, `CLAUDE.md` | **PASS** — untouched |
| `docs/phases/phase-0…7.md` | **PASS** — untouched; historical record preserved as written |
| `loadtest/**` | **PASS** — untouched; no script or result file modified |
| `render.yaml`, `docker-compose.yml`, `.env`, `.env.example`, `client/.env.example` | **PASS** — untouched |
| `git diff --check` | **PASS** — exit 0, no whitespace errors |
| Benchmarks re-run | **NOT RUN** — by design. Every number in Phase 8 is cited from Phase 6/7 evidence |
| Functional re-verification of Phases 1–7 | **NOT RUN** — Phase 8 changed no application code, so re-running would measure nothing new |
| Commit / merge / push / deploy | **NONE** — HEAD still `59778a5`; `main` and `origin/main` still `692ffcf` |
| Processes left running | **PASS** — the API server and Vite dev server started for M1 were stopped; Redis `dbsize=0`. The pre-existing `vite preview` on `:4173` and the four Docker containers predate this session and were left untouched |
| Render auto-deploy state | **NOT VERIFIED** — not queried |
| Phase 6/7 code against Neon/Upstash | **NOT VERIFIED** — never run there |

---

## 10. Git state and commit boundary

```
branch      feat/benchmarks
HEAD        59778a5   feat: add Phase 7 benchmarks
main        692ffcf
origin/main 692ffcf
divergence  main...feat/benchmarks = 0 / 9

 M BACKLOG.md
 M README.md
?? docs/architecture.md
?? docs/phases/phase-8-plan.md
?? docs/phases/phase-8-closeout.md   (this file)
```

**Nothing has been committed, merged, pushed or deployed.** The intended Phase 8
commit is one commit covering exactly these five documentation files, on explicit
authorisation.

---

## 11. Open items leaving Phase 8

1. **The merge decision.** Phases 3–7 remain unmerged. Recommended `--no-ff`
   preserving history, after the Phase 8 commit — an explicit, separate decision.
2. **The deploy decision.** Separate again, and never combined with a merge.
   Blocked behind R-1…R-6 in §2, in particular migrations `003`/`004` on Neon and
   the sweep's 60-second default.
3. **H1 — rotate the Neon credential.** Tracked in `BACKLOG.md` P0. The user
   performs it; Claude does not.
4. **M6 — the ownership rewrite (8.4).** User-initiated only, on a scratch
   branch, never proposed by Claude. Not started.
5. **M7 — the interrogation (8.5).** Partially conducted: Area 1 only, three
   questions answered. **Areas 2–9 remain owed**; see §8.
6. **README screenshot/GIF**, and a **verified demo link and credentials** —
   `BACKLOG.md` P0, deliberately unticked.
7. **F-2, F-3, F-4** stay deferred with their evidence; **F-5, F-6** stay closed.
   **F-1** is explained and unfixed by design — a fix would need the client guard
   keyed on the account rather than on one tab's holds, and was not attempted.
