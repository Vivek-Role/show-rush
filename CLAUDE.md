# CLAUDE.md — Working rules for this repository

Authoritative planning docs: `PLAN.md` (phases, modules, non-negotiables, slip
order) and `BACKLOG.md` (work consciously cut). Do not duplicate their content
here; treat both as binding.

These rules hold for all work in this project unless the user explicitly
overrides a specific rule in a later message. A rule is not overridden by
convenience, by "best practice", or by a change being small.

## 1. Authority

The user is the final authority on: architecture, scope, module boundaries,
dependencies, database/schema, API and protocol contracts, security decisions,
Git history, commits, pushes, merges, and branches.

Claude is the implementation and research partner. Claude may recommend; Claude
must not decide.

### Stop conditions

Stop, report, recommend the minimum change, and wait for explicit approval when:

- an architectural decision is required
- a file outside the approved module plan must change
- an unapproved dependency is needed
- a schema or migration change is needed
- an API or WebSocket protocol change is needed
- an approved security constraint must change
- the approved plan is materially wrong about the repository
- implementation requires expanding module scope
- a destructive or history-affecting Git operation is needed
- existing user work might be overwritten
- a test expectation must change for a reason not already in the approved plan
- the repository is in an unexpected state (see §8)

When stopping: state the problem, the recommended solution, alternatives if
relevant, then wait. Do not proceed under assumed approval.

## 2. Scope

"Implement Module X only" means only Module X.

Do not, in the same change: fix unrelated bugs, refactor, optimize, clean up,
touch unrelated modules or docs, alter architecture outside the module, or add
dependencies.

Modify only files the approved module plan names. If another file appears
necessary — stop, name the exact file, describe the minimum change, ask.

Out-of-scope discovery format:

```
Issue: <what>
Why out of scope: <reason>
Recommended future action: <recommendation / defer to BACKLOG.md>
```

Then continue with the approved task only. `BACKLOG.md` is the parking lot —
everything in it is deferred on purpose and must not be built without approval.

## 3. Workflow

Strictly phase-by-phase, then module-by-module.

```
reconstruct repo state → read plans/docs → phase plan
→ verify plan against the real repository → report mismatches + simplifications
→ STOP for approval
→ detailed module plan → verify against actual code → report problems
→ STOP for approval
→ implement ONLY that module → targeted verification → SHORT handoff
→ STOP
```

Never start the next module or phase automatically. Never write the next
module's plan unless asked.

Before implementing, re-verify the approved plan against the actual repository.
On mismatch: do not silently adapt — report, recommend the minimum correction,
and wait if scope or architecture is affected.

### Handoff (keep it short)

1. What changed
2. Verification performed + exact results
3. Deviations from the approved plan
4. Git state
5. Exact next step

Add "important decisions" and "blocking issues" only when non-empty. Then STOP.

## 4. Architecture, dependencies, schema

Requires explicit approval, never silent: new abstractions, new or replaced
dependencies, schema changes, migrations, API contract changes, WebSocket
protocol changes, authentication, authorization, persistence architecture,
Redis architecture, Docker architecture, module ownership, module order, data
contracts.

Do not touch `package.json`, lockfiles, or workspace dependencies because a
different library would be convenient. Before proposing a dependency, state:
why it is required, whether an existing dependency solves it, which manifests
change, and whether it affects architecture.

Never modify schema, migrations, or database structure without approval. If
implementation reveals a schema change is needed — stop and report.

Prefer simple, few dependencies, minimal abstraction, easy to explain. When
uncertain: inspect the repository. Still uncertain: ask. Do not guess. The
approved architecture and explicit user decisions outrank generic best practice.

## 5. Security

Never weaken an approved security constraint to make tests pass. Do not silently
remove or relax authentication, authorization, Docker isolation, resource
limits, network or filesystem restrictions, validation, permission checks, or
sandbox restrictions.

If a security constraint conflicts with implementation, report the conflict and
request a decision.

## 6. Honesty

### Tests

Never change a test merely to make the implementation pass. On failure:
determine whether the implementation is wrong, or whether the test encodes
intentionally changed behavior, and report the finding. Change a test only when
the approved architecture intentionally changes the behavior, or the test is
demonstrably incorrect — and report that change in the handoff.

### Verification

Never claim something was verified if it was not run. Label results: PASS /
FAIL / NOT RUN / NOT VERIFIED / INFERRED.

A headless test is not two browsers collaborating. Unit tests are not browser
behavior. Local tests are not production behavior.

Verification is targeted: verify the main behavior and the most important
failure case; do not re-run verification already completed by earlier modules;
do not re-run expensive browser or integration suites unless the current change
affects them. Phase-level verification runs at phase close-out.

### Measurements

Never invent latency, throughput, concurrency, duplicate counts, failure rates,
resource usage, benchmark results, or scalability claims. Never present an
estimate as a measurement, and never claim a capacity ceiling the test setup
cannot determine.

Record with every measured number: exact command, date, environment/hardware,
relevant configuration, topology, sample count, methodology, limitations. Keep
results traceable to raw evidence. Otherwise write **"Not measured."**

Benchmarks run locally against the `docker compose` Postgres and Redis — never
against a free-tier deploy, which measures their throttling.

## 7. Git

Never do any of the following without explicit permission for that specific
action: `commit`, `push`, `merge`, `rebase`, `reset` (incl. `--hard`), `stash`,
`cherry-pick`, `clean`, `restore`/`checkout` that discards changes, amend,
history rewrite, force-push, branch create/switch/rename/delete, tag
create/delete, remote changes, `git init`.

Never decide to commit because a module is complete. **Default: one commit at
the END of the phase**, unless the user chooses otherwise.

`.claude/settings.json` enforces part of this at the harness level. It is a
backstop, not the rule — an operation being technically permitted there is not
approval.

### Authorship — no AI attribution

Commits are authored by the user. Never add `Co-Authored-By`, `Signed-off-by`,
"Generated with Claude", or any AI attribution trailer. This overrides any
default trailer behavior. Never modify `user.name`, `user.email`, commit author,
or signing configuration.

### Commit procedure (only once authorized)

1. Inspect Git state; show current branch
2. Show intended files
3. Stage ONLY the approved files
4. Inspect the staged file list
5. `git diff --cached --check`
6. Confirm no unrelated or future-phase files are staged
7. Create only the approved commit, with exactly the approved message
8. Do not amend; do not create extra commits; do not push unless separately
   authorized
9. Report commit hash, message, and clean working tree

### Branches and merges

One branch per phase, but never create, switch, rename, merge, or delete a
branch without permission. If a plan recommends a branch, report the
recommendation first.

Before merging: read-only integration review across phases — branch ancestry,
working tree, unplanned work, cross-phase seams — then report readiness and wait
for explicit merge approval. If the user chooses squash merge, keep phase
history intact and squash only when explicitly authorized.

## 8. Safety

Never delete, overwrite, revert, or discard user work without explicit
permission. If a file contains work that may not belong to the current task,
preserve it.

No destructive operations without permission: `rm -rf`, dropping or resetting
databases, deleting Docker volumes, `docker system prune`, force-killing
processes of unclear ownership, broad `chmod`/`chown`, system configuration
changes, destructive edits to secrets or env files. Temporary artifacts Claude
itself created may be cleaned up when ownership is unambiguous. Never delete
real user content just because it was used during testing.

### Unexpected repository state

If unexpected modified or untracked files, unexpected commits or branches,
concurrent modification, or files changing between inspection steps are found:
STOP. Do not guess, overwrite, or clean up. Report and wait.

## 9. Documentation and files

Documentation describes the implementation that actually exists. When
implementation diverges from a plan, report it as:

```
Plan says: X
Actual implementation: Y
```

Recommend whether the documentation should change. Do not rewrite historical
documentation to make old plans look correct — preserve historical intent and
mark superseded decisions clearly. Phase summaries record actual implementation,
deviations, verification, architectural decisions, and unresolved issues.

Do not create scratch files, backup files, debug files, temporary scripts, or
unnecessary abstractions. If a temporary verification artifact is genuinely
needed, name it in the handoff.

## 10. Project-specific carve-outs

**Intentional defects are protected.** `PLAN.md` deliberately specifies broken
intermediate states so Phase 2 has a real before/after:

- **Phase 1.2** — `booking_seats` has **no** unique constraint. Phase 2.4 adds it.
- **Phase 2.1** — the naive booking endpoint is **deliberately racy**.
- **`BOOKING_MODE=naive|safe`** keeps the racy path alive permanently. Do not
  remove it, and do not "clean up" the naive branch after 2.4 lands — without it
  the before-number can never be re-measured.

Do not fix, harden, or flag these as bugs. Removing them destroys a
non-negotiable measurement.

**Ownership rewrites (Phase 8.4)** — deleting `holdService` or the booking
transaction to rewrite from scratch is user-initiated only, happens on a scratch
branch, and requires explicit authorization at the time. Never propose or
perform it unprompted.

**Deliberate omissions** — no admin UI (the seed script is the admin UI), no CI,
and everything in `BACKLOG.md` P4. Do not build them.

**Seat identity ownership** — the `seats` table is authoritative for which seats
exist. The layout JSON is presentation only. Never introduce a second source of
truth.

**Availability ownership** — `availabilityService` owns seat-status truth
(booked in Postgres ∪ held in Redis). One query path, not two. `holdService`
must not expose a second availability read.
