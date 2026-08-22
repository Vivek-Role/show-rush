# Phase 8 — Docs + ownership

**Phase 8 plan — planning only. No implementation authorized.**

**Status:** APPROVED PLANNING BASELINE. Nothing implemented.
**Plan approved:** 2026-08-22, in the Phase 7 session
**Repository state at planning time:** `feat/benchmarks` @ `59778a5`, working tree clean
**Source of truth:** `PLAN.md` §Phase 8, `BACKLOG.md`, `docs/phases/phase-7-benchmarks.md`
**Rules:** `CLAUDE.md` — not restated here

> This document exists so a fresh Phase 8 session can start from the approved
> plan rather than re-deriving it. It records decisions, not work done.

---

## 0. Repository state as inspected

| | |
|---|---|
| Branch / HEAD | `feat/benchmarks` @ **`59778a5`** ("feat: add Phase 7 benchmarks"), working tree **clean** |
| `main` / `origin/main` | both **`692ffcf`** — the Phase 2 merge |
| Divergence | `main...feat/benchmarks` = **0 / 9** — **Phases 3–7 are all unmerged** |
| Phase docs | `phase-0` … `phase-7` present, all closed out |
| Architecture doc | **does not exist** — `docs/` contains only `phases/` |

### Plan-vs-repository mismatches found during planning

```
Plan says: 8.1 README — demo link, benchmark table, screenshot.
Actual:    README's header still reads "Status: Phase 3 (Seat map UI) complete",
           and "Known limitations" still says "No seat holds yet — Phase 4" and
           "No payment — Phase 5". Phase 6 §8 already flagged this for 8.1.
```

```
Plan says: Phase 8 happens on `main`.
Actual:    main is at Phase 2. Phases 3-7 are nine unmerged commits, so
           documentation written "on main" would describe a codebase main does
           not contain. M0 reviews this; it does not resolve it.
```

```
Not in PLAN.md: the deployed demo at show-rush.onrender.com is served from
           main, i.e. Phase 2 code. It has no holds, no payment and no live
           updates, so the README's demo section advertises capabilities the
           link does not serve.
```

---

## 1. Objective

Make the repository tell the truth about what was built, and prove ownership of
it. Phase 8 produces **documentation and one diagnosis**. It is not a feature
phase.

The deliverable is that someone reading the repository cold gets an accurate
picture, and that every decision in it can be defended out loud.

---

## 2. Diagnosis vs implementation boundary

This is the spine of the plan, because Phase 7's carried-forward findings mix the
two.

**Diagnosis modules** (M0, M1, M2, M7) produce evidence and a written finding.
They change **no application code, no schema, no dependencies, and no
documentation other than the Phase 8 close-out**. If a diagnosis turns out to
require instrumentation, it **stops and asks** rather than instrumenting.

**Implementation modules** (M3, M4, M5) change **documentation files only**.

**M6** is the single exception and is confined to a scratch branch that is never
merged. It is user-initiated only.

**No Phase 8 module fixes F-2, F-3 or F-4.** Those were deferred at the Phase 7
7.3b gate and remain deferred unless explicitly reopened. **F-5 and F-6 are
closed and are not reopened.**

---

## 3. Modules, in order

| # | Module | Type | Approval gate before starting |
|---|---|---|---|
| **M0** | Integration review — **read-only** | Diagnosis | **YES** |
| **M1** | F-1 diagnosis (own-hold UI symptom) | Diagnosis | **YES** |
| **M2** | rAF disposition | Decision | **YES** |
| **M3** | README rewrite (8.1) | Docs | after M0–M2 |
| **M4** | Architecture doc (8.2) | Docs | after M3 |
| **M5** | `BACKLOG.md` update (8.3) | Docs | after M1–M4 |
| **M6** | Ownership rewrite (8.4) | Scratch branch | **user-initiated only** |
| **M7** | Interrogation (8.5) | Review | after M3–M5 |
| **H1** | Neon credential rotation | Housekeeping | **user performs, not Claude** |

---

### M0 — Integration review (READ-ONLY. No merge.)

**M0 does NOT merge anything.** It is a read-only review that produces a written
report and stops.

Phases 3–7 are nine unmerged commits on `feat/benchmarks`; `main` and
`origin/main` are both at `692ffcf`. `CLAUDE.md` §7 requires a read-only
integration review before any merge: branch ancestry, working tree state,
unplanned work, cross-phase seams.

**M0 produces that review and nothing else.**

**Whether to merge Phases 3–7 into `main` is a SEPARATE, EXPLICIT Git decision**,
taken by the user after reading the review. It is **not** part of M0, not implied
by approving M0, and not implied by approving this plan.

**Also separate from merging:** whether a merge triggers a deploy. If `main`
auto-deploys on Render, merging changes what the demo serves, and Phase 6/7 code
has never run against Neon or Upstash. **Merging and deploying must never be
combined into one step.**

Because M3 and M4 describe a codebase, the outcome of that separate merge
decision changes their wording throughout — which is why the review comes first.

**Model:** Opus · **effort: medium.** Ancestry and seam reasoning; small output.

---

### M1 — F-1 diagnosis: the unexplained own-hold UI symptom

**Do not assume the previous explanation is correct.** Phase 7 deliberately
reproduced the proposed WebSocket/HTTP race and **it did not reproduce**: across
25 trials the frame arrived **after** the HTTP 201 every time (min +0.13 ms,
median +1.91 ms, max +7.18 ms; **0/25** arrived first). `broadcastSeats` awaits a
Postgres query plus a Redis `MGET` before sending, so the response reliably wins.
**That hypothesis is dead and must not be revived without new evidence.**

**Still established:** the server broadcasts a user's own hold back to them as
`held` (**25/25**), so the client guard at `SeatMapPage.jsx:133` is load-bearing.

**Still missing, in priority order:**

1. **Whether the symptom reproduces at all under controlled conditions.** It was
   only ever seen incidentally, in sessions that were themselves contaminated.
   There is no reproduction procedure. Everything else is premature until one
   exists.
2. The actual order of events in the browser — when a seat's rendered status
   flips to `held`, relative to frame arrival and hold-response resolution.
3. Whether `heldRef` was populated at flip time.

#### Competing hypothesis to test FIRST

> **The load generator and the browser shared one account.** `seat-churn.js`
> authenticates as `demo@show-rush.dev` — the same user the browser was logged in
> as. `heldRef` contains only seats *this client* acquired, but broadcasts are
> viewer-agnostic. A seat held by **k6 under the same user id** therefore arrives
> as `held`, the guard misses (this client never held it), and it renders dark —
> while a REST refetch with `forUserId` reports that same seat `available`.

That reproduces the observed contradiction exactly: dark seats that look free
after reload, and a mixture of dark and green among "the user's own" seats. It is
cheaper to test than the alternatives and fits the observations better. If it
holds, F-1 is substantially a **test-methodology artifact** rather than a product
defect — though the guard's behaviour under a genuinely concurrent second session
still deserves a written note.

#### Method — two-account, console/DevTools only, no repository instrumentation

1. **Two accounts.** The browser uses a **fresh, separately registered user**;
   the load generator keeps the **demo account**. This alone discriminates the
   competing hypothesis.
2. **Console and DevTools observation only.** A `MutationObserver` on
   `.seatmap__rows` filtered to `data-status` (the technique Phase 6 used), plus
   Chrome DevTools **Network → WS → Frames**, which timestamps frames natively.
   **No repository instrumentation initially.**
3. **Low-rate churn** (2–3 VUs), so events are countable by eye rather than at
   ~238/second.
4. **Record per event:** seat id, frame arrival time, `data-status` flip time,
   and whether the seat was in this client's own selection.

#### Escalation

**If console/DevTools observation cannot resolve it and repository
instrumentation becomes necessary — STOP and ask.** Any instrumentation would go
on a scratch branch that is never merged, and requires explicit approval at that
time. Do not write it speculatively.

#### Acceptable outcomes

- **CONFIRMED** — with a stated mechanism and a reproduction procedure
- **EXPLAINED / shared-account artifact** — the competing hypothesis holds
- **NOT REPRODUCIBLE** — recorded clearly as such

**All three are passing results.** "Not reproducible" is an honest finding, not a
failure.

**No fix in Phase 8 under any outcome, without separate explicit approval.** A
fix requires a reproduction, or it cannot be shown to have worked.

**Model:** Opus · **effort: high.** This is where a wrong inference already cost
significant time.

---

### M2 — rAF disposition: PARKED

**The rAF limitation is parked. No further rAF benchmark is run in Phase 8. No
ratio is invented, estimated or published.**

Phase 7 measured **24.1 Hz idle** against a 59 Hz panel, with an implied ~0.7 Hz
under load. At display rate the batched/immediate flush ratio would be roughly
**4:1**; at the observed cadence it computes to roughly **380:1**. Both cannot be
true, so **neither is claimed**.

What is already proven and may be stated: **zero message loss** on both halves
(4,978 and 4,772 broadcasts, all received); `immediate` performs **exactly 1.000
flushes per message**; batching demonstrably collapses thousands of messages into
tens. The missing piece is one ratio, not the claim that batching works.

**Decision: it remains a documented limitation.** `README.md` and
`docs/phases/phase-7-benchmarks.md` §5 already word this correctly, so **M2 may
produce no file change at all.**

If it is ever re-attempted (not in Phase 8), the prerequisite is an environment
**demonstrated** to sustain ~59 Hz under a ~238 msg/s arrival rate, measured
before and during the run — realistically a non-WSL host or a second machine.

**Model:** Sonnet · **effort: low.** A decision, not work.

---

### M3 — README rewrite (8.1)

The largest documentation job, because the README is materially wrong today.

**Must fix:**
- the status header (still says "Phase 3 complete")
- "Known limitations" (still says holds and payment do not exist — false for six
  phases)
- the demo section (advertises capabilities the deployed link does not serve)
- add the architecture diagram and screenshot/GIF `PLAN.md` 8.1 asks for

**Must preserve exactly — this is the hard constraint:**
every measured number **and its method**. Phase 2's before/after, the Phase 3
rendering baseline, the Phase 6 hidden-tab caveat, the Phase 7 results table, and
the "Still not measured" section. **The rewrite must not launder a single
measurement, drop a caveat, or soften a limitation.**

Two `BACKLOG.md` P0 items are verified here as facts, not prose: the demo link
must actually work, and the demo credentials must actually log in — **tested, not
assumed**.

**Model:** Opus · **effort: medium-high.** Judgement about what to keep is the
hard part; the prose is not.

---

### M4 — Architecture doc (8.2)

**New file: `docs/architecture.md`.** Six decisions, each with the chosen
approach, **two rejected alternatives**, and the reasoning/evidence:

| # | Decision |
|---|---|
| 1 | `UNIQUE` constraint vs `SELECT … FOR UPDATE` vs advisory locks |
| 2 | Redis holds vs DB-only holds vs no holds |
| 3 | Hold TTL length — why 7 minutes and not 3 or 15 |
| 4 | WebSocket vs SSE vs polling for seat updates |
| 5 | Postgres vs MongoDB for this workload |
| 6 | What happens on Redis failure, and whether the system stays correct |

**This is the module Phase 7 most directly feeds.** Four of the six now rest on
measurement rather than assertion — **cite the measurements, do not re-derive
them**:

- **#1** — Phase 7 §4.1: 379 · 305 · 379 → 0 · 0 · 0
- **#4** — Phase 7 F-4: one watcher costs **25%** of hold throughput (499 → 373/s)
- **#6** — Phase 6 §7: measured degradation with Redis stopped (holds fail closed
  with 503; bookings still succeed and still broadcast)
- **#2/#3** — Phase 7 F-2 and §4.3 for the queueing and throughput context

`BACKLOG.md` P1 already points at "Phase 8.2" as the canonical list, so this file
must exist for that pointer to be honest.

**Model:** Opus · **effort: high.** The highest-value artifact in Phase 8.

---

### M5 — `BACKLOG.md` update (8.3)

Add, with evidence attached:

- **F-2** `pg` pool pinned at 10 → **P2**, with the measured evidence (10
  connections at every sample under 200 VUs while Postgres allows 100;
  throughput flat 50→200 VUs while latency scales ~4.4×)
- **F-3** duplicate `booking_seats` indexes → **P2 schema maintenance** (planner
  uses the non-unique index for the whole-show path, 4,627 scans, and the unique
  one for the scoped path, 8; both maintained on every insert)
- **F-4** broadcast cost → recorded as a **measured architectural trade-off, not
  a defect**
- **F-1** → whatever M1 concludes
- **rAF ratio** → per M2, as a documented limitation
- Tick the P0 items Phase 7 completed: `loadtest/` scripts committed; benchmark
  table filled with measured numbers

**F-5 (WebSocket memory) and F-6 (seq scans) stay CLOSED and are not reopened.**
Do not add indexes merely because a sequential scan exists.

**Model:** Sonnet · **effort: medium.** Mechanical once M1–M4 are settled.

---

### M6 — Ownership rewrite (8.4) — USER-INITIATED ONLY

`CLAUDE.md` §10 is explicit: deleting `holdService` or the booking transaction to
rewrite from scratch is **user-initiated, on a scratch branch, and requires
explicit authorization at the time.**

**Claude never proposes, starts, or participates in this unless asked.** It is
listed here only so the plan is complete. The scratch branch is never merged, so
a failed attempt costs nothing by construction.

**Model:** n/a — the user drives this.

---

### M7 — Interrogation (8.5)

Claude reads the repository and questions the user on it: the race under
`READ COMMITTED`, why the constraint is the guarantee and Redis the optimization,
what happens when Redis dies, why the naive path still exists permanently, what
was deliberately not built and why.

**Produces no files.** The output is the user's answers.

**Model:** Opus · **effort: medium.** Question quality is the whole value.

---

### H1 — Neon credential rotation (separate manual security task)

**Not a Phase 8 module.** It is housekeeping with a security deadline and does not
belong in a documentation phase's commit.

`.env` contains `NEON_DATABASE_URL`. No code reads it, `.env.example` does not
list it, and `.env` is gitignored — **it was never committed.** But Phase 6 §9
records that its value, including the password, was printed in full to a session
transcript. **It has not been rotated.**

**Claude does not rotate it.** It requires signing in to Neon, and the credential
belongs to the user.

**Required action (user performs):**
1. Rotate the password in the Neon console.
2. Update any consumer — Render environment variables, local `.env`.
3. Delete `NEON_DATABASE_URL` from `.env` entirely, since nothing reads it.

**Where it belongs in the workflow:** before any production use and before the
repository is shown to anyone — **independent of Phase 8's progress**. A tracked
`BACKLOG.md` entry may be added under M5 so it is not lost; that is an open
decision (§8).

---

## 4. Exact file scope

### May be modified — documentation only

```
README.md                     M3 — rewrite, preserving every measurement
docs/architecture.md          M4 — NEW FILE
BACKLOG.md                    M5 — the one phase where editing it is in scope
docs/phases/phase-8-*.md      close-out, written after verification
```

`BACKLOG.md` moves from protected to writable **only** because `PLAN.md` 8.3 is
precisely "keep it current".

### Explicitly protected — modified by no Phase 8 module

```
server/src/**                 all application code
client/src/**                 all client code
server/migrations/**          no migration 005; F-3 stays deferred
package.json · package-lock.json
server/package.json · client/package.json
PLAN.md · CLAUDE.md
render.yaml · docker-compose.yml
.env · .env.example · client/.env.example
docs/phases/phase-0…7.md      historical record, preserved as written
loadtest/**                   every script, SQL file and result — Phase 7 evidence
```

**No dependency may be added, removed or upgraded in Phase 8.**

---

## 5. Verification strategy

**Diagnosis modules (M0, M1, M2, M7)** are verified by their evidence, not by
tests: a stated procedure, raw observations, and an explicit label
(**CONFIRMED / EXPLAINED / NOT REPRODUCIBLE**). "Not reproducible" is a passing
result.

**Documentation modules (M3–M5)** are verified by fact-checking against the
repository — every claim traced to code, a migration, or a recorded measurement:

- every number in the README traced to a `loadtest/results/*.json` or a phase doc
- every capability claim checked against code that exists on the branch described
- every internal link resolves
- the demo link and demo credentials **actually tested**, not assumed
- **no measurement's method, caveat or limitation dropped in the rewrite** —
  diffed explicitly, not trusted

**One verification pass at the end of the phase**, as in Phase 7 — **not per
module.**

**No functional re-verification of Phases 1–7.** Phase 8 changes no application
code, so re-running those suites would measure nothing new. Labels
(PASS / FAIL / NOT RUN / NOT VERIFIED / INFERRED) apply as always.

---

## 6. Acceptance criteria

1. M0's integration review is written and **no merge has occurred**.
2. F-1 carries a definite label with evidence, and **no fix was applied** (M1).
3. The rAF item is recorded as parked, with **no invented number** (M2).
4. README describes what actually exists, and **every measurement survives with
   its method** (M3).
5. `docs/architecture.md` exists with six decisions × two rejected alternatives,
   citing measurements (M4).
6. `BACKLOG.md` reflects the 7.3b rulings; **F-5 and F-6 still closed** (M5).
7. Protected paths untouched — verified by path, as at the Phase 7 gate.
8. One commit at phase end, on explicit authorization.

---

## 7. Rollback and safety

Phase 8 is low-risk: documentation edits are trivially revertible, and Phase 7's
commit **`59778a5`** is a clean restore point.

- **No merge occurs in Phase 8 as planned.** M0 is read-only. Any merge is a
  separate, explicitly authorized Git decision, and would carry its own review,
  no force-push and no rebase of shared history.
- **The README rewrite could silently drop a measurement.** Mitigation: diff the
  before/after explicitly and check every number against its raw file, rather
  than trusting the rewrite to have carried everything.
- **M6's scratch branch is never merged**, so a failed ownership attempt costs
  nothing.
- `BOOKING_MODE=naive`, the deliberately racy path, `booking_seats` uniqueness
  and every Phase 2 artefact remain protected under `CLAUDE.md` §10 throughout.
  Do not "clean up" the naive branch.
- Standard prohibitions hold: no commit, push, merge, rebase, reset, amend or
  deploy without explicit per-action approval.

---

## 8. Approval gates

```
M0 integration review    → STOP, present review, wait.  NO MERGE.
merge decision           → SEPARATE explicit decision, not part of M0
deploy decision          → SEPARATE again, never combined with a merge
M1 F-1 diagnosis         → STOP, wait
   instrumentation?      → STOP AGAIN and ask; never write it speculatively
   any fix               → STOP; no fix in Phase 8 without separate approval
M2 rAF disposition       → STOP, wait  (parked; no benchmark)
M3 / M4 / M5 docs        → proceed once M0-M2 are settled
M6 ownership rewrite     → user-initiated only; never proposed by Claude
M7 interrogation         → no files; no gate
H1 credential rotation   → user performs; Claude does not rotate
commit                   → STOP, explicit authorization, exactly one commit
```

---

## 9. Required module-by-module workflow

`CLAUDE.md` §3 applies unchanged:

```
reconstruct repo state → re-verify this plan against the real repository
→ report mismatches + simplifications → STOP for approval
→ implement ONLY that module → SHORT handoff → STOP
```

- **Never start the next module automatically.**
- **Re-verify this plan against the repository before implementing**, since it was
  written at `59778a5` and the repository may have moved.
- On mismatch: **do not silently adapt** — report, recommend the minimum
  correction, and wait if scope or architecture is affected.
- Handoff format: what changed · verification performed with exact results ·
  deviations · Git state · exact next step. Then **STOP**.
- **Verification happens ONCE**, after the whole phase (§5) — not per module.
- Close-out documentation is written **only after** that verification pass.

---

## 10. Recommended model and effort

| Module | Model | Effort | Why |
|---|---|---|---|
| **M0** integration review | Opus | medium | Ancestry and cross-phase seam reasoning; small output |
| **M1** F-1 diagnosis | **Opus** | **high** | A wrong inference already cost significant time here |
| **M2** rAF disposition | Sonnet | low | A decision, likely no file change |
| **M3** README rewrite | Opus | medium-high | Judging what must be preserved is the hard part |
| **M4** architecture doc | **Opus** | **high** | Highest-value artifact in the phase |
| **M5** BACKLOG update | Sonnet | medium | Mechanical once M1–M4 are settled |
| **M6** ownership rewrite | — | — | User-driven; Claude does not participate |
| **M7** interrogation | Opus | medium | Question quality is the whole value |
| **H1** credential rotation | — | — | User performs manually |

---

## 11. Open decisions requiring approval before implementation

1. **Merge Phases 3–7 into `main`?** If so, preserving phase history or squashed
   — and separately, does that trigger a deploy? **Not part of M0.**
2. **F-1:** approve the two-account, console-only diagnosis, including that
   "not reproducible" is an acceptable outcome?
3. **rAF:** confirmed parked for Phase 8 (recorded as decided in §M2).
4. **Architecture doc location** — `docs/architecture.md`? `BACKLOG.md` P1 points
   at "Phase 8.2" without naming a path.
5. **Should `BACKLOG.md` carry a tracked item for the Neon rotation**, or should
   that stay out of the repository entirely?

---

**Phase 8 implementation has NOT started. This document is the approved planning
baseline for the new Phase 8 session.**
