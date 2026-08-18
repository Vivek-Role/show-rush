# Phase 0 — Setup

**Status:** PLAN — awaiting approval
**Branch:** `main`
**Source of truth:** `PLAN.md` §Phase 0, `BACKLOG.md`
**Rules:** `CLAUDE.md` (workflow, Git policy, honesty — not restated here)
**Plan written:** 2026-08-18

## 1. Goal

Stand up the full delivery path — WSL toolchain, repo, deployed app, cloud
Postgres and Redis, and a local Docker stack — before any feature code exists.
When Phase 0 is done, a deployed URL reports both data stores healthy, and
`docker compose up` gives a local Postgres and Redis that Phase 2's benchmarks
can run against.

The entire point is to find deploy problems now rather than on day 6.

## 2. Done when

> The deployed URL reports both connections healthy, **and** `docker compose up`
> gives a local Postgres + Redis the app can point at.

## 3. Non-negotiables, traps, and intentional defects

**None for this phase** — Phase 0 introduces no intentional defects.

One trap: Phase 0's Express app is **deliberately minimal** — a single file, no
`routes/`, `services/`, or `db/` directories. That structure is Phase 1.1's job
and Phase 1.1 will restructure this file. Do not build the real skeleton here.

## 4. Scope

**In:** WSL toolchain, git repo, npm workspace, minimal Express, deploy, cloud
Postgres + Redis, local Docker stack, `/health`.

**Out:** schema and migrations (Phase 1.2), auth (1.3), seed (1.4), read APIs
(1.5), any React (Phase 3.1), CI (`BACKLOG.md` P2, deliberately skipped).

## 5. Repository state check

Inspected 2026-08-18 in WSL Ubuntu 26.04, not assumed.

| PLAN.md assumes | Actually in repo / environment | Mismatch |
|---|---|---|
| Repo exists | `fatal: not a git repository` | expected — 0.2 creates it |
| Node 20.17.0 | **`node` not installed in WSL** | **yes — see Q1** |
| npm available | `npm` resolves to `/mnt/c/Program Files/nodejs/npm` — **the Windows npm** | **yes — critical, see R1** |
| Docker available | `docker` resolves to the Windows Docker Desktop shim; **daemon not reachable** | **yes — see Q2** |
| k6 installed | not installed in WSL | yes — 0.1 installs it |
| git | 2.53.0, native WSL | none |
| — | Ubuntu 26.04 LTS; apt `nodejs` candidate is **22.22.1**, not 20.x | relevant to Q1 |

Existing files, all to remain untouched: `PLAN.md`, `BACKLOG.md`, `CLAUDE.md`,
`.claude/settings.json`.

**Requiring your decision:** Q1 and Q2 in §15. Everything else is mechanical.

## 6. Modules

Strictly sequential. Chain: `0.1 → 0.2 → 0.3 → 0.4 → 0.5 → 0.6 → 0.7`

Deploy (0.4) deliberately precedes the data stores — a hello-world that reaches
production proves the pipeline before anything can complicate it.

### 0.1 — Environment baseline
- **Purpose:** a WSL-native toolchain, with no Windows binaries leaking in
- **Files:** none in the repo
- **Exposes:** working `node`, `npm`, `docker`, `k6` inside WSL
- **Depends on:** nothing
- **Done when:** `command -v node npm docker k6` all resolve to `/usr/...` or
  `~/.nvm/...` paths — **never `/mnt/c/...`** — and `docker info` succeeds
- **Verification:** print each resolved path and version; assert no `/mnt/c`
- **Model / effort:** Sonnet / low

### 0.2 — Repo init
- **Purpose:** version control and environment contract
- **Files:** `.gitignore`, `.nvmrc`, `.env.example`, `README.md` (stub)
- **Exposes:** `main` branch; the list of required env vars
- **Depends on:** 0.1
- **Done when:** `git init`, `main` checked out, nothing secret is trackable
- **Verification:** `git status` clean of `.env` and `node_modules`; `.env.example`
  lists every variable 0.6 and 0.7 will need
- **Model / effort:** Sonnet / low

### 0.3 — Workspace skeleton + minimal Express
- **Purpose:** the smallest server that can be deployed
- **Files:** `package.json` (root), `server/package.json`, `server/src/index.js`
- **Exposes:** `GET /` returning 200; `npm run dev` and `npm start`
- **Depends on:** 0.2
- **Done when:** the server boots locally and answers on `PORT`
- **Verification:** `curl localhost:3000/` returns 200
- **Model / effort:** Sonnet / low

### 0.4 — Deploy hello-world
- **Purpose:** prove the deploy pipeline before data stores complicate it
- **Files:** `render.yaml` *(or Railway dashboard config — no file; see Q5)*
- **Exposes:** a public URL
- **Depends on:** 0.3
- **Done when:** the public URL returns 200 from a cold start
- **Verification:** `curl <public-url>/`; record cold-start seconds — free tiers
  sleep, and `BACKLOG.md` P0 wants that number in the README
- **Model / effort:** Sonnet / medium — first deploys always surprise
- **Note:** account setup and dashboard steps are yours; I cannot provision

### 0.5 — Local stack
- **Purpose:** the Postgres and Redis that Phases 2 and 7 benchmark against
- **Files:** `docker-compose.yml`, `.env` (gitignored)
- **Exposes:** local Postgres on 5432, Redis on 6379
- **Depends on:** 0.1, 0.2
- **Done when:** `docker compose up -d` runs, both accept connections, major
  versions match the hosted services
- **Verification:** `pg_isready`; `redis-cli ping` → `PONG`
- **Model / effort:** Sonnet / low

### 0.6 — Cloud data services
- **Purpose:** hosted Postgres and Redis for the deployed app
- **Files:** `.env.example` (modify — add `DATABASE_URL`, `REDIS_URL`)
- **Exposes:** connection strings, set as deploy-host env vars
- **Depends on:** 0.4
- **Done when:** Neon and Upstash provisioned, credentials in the deploy host's
  env — never committed
- **Verification:** deferred to 0.7, which is the real test
- **Model / effort:** Sonnet / low
- **Note:** signups are yours; I wire up what you paste

### 0.7 — `/health`
- **Purpose:** the phase's actual acceptance test
- **Files:** `server/src/index.js` (modify)
- **Exposes:** `GET /health` → `{ db: ok|error, redis: ok|error }`
- **Depends on:** 0.5, 0.6
- **Done when:** green **from the deployed URL** against Neon + Upstash, and
  green locally against Docker
- **Verification:** `curl <public-url>/health` and `curl localhost:3000/health`;
  then stop one local container and confirm it reports `error` rather than
  hanging or 500-ing
- **Model / effort:** Opus / medium — the failure path is the point

**Phase effort:** ~0.5 day, most of it 0.1 and 0.4. **Complexity hotspots:**
the Windows-PATH leak (R1) and the first deploy.

## 7. File scope

**New:** `.gitignore` · `.nvmrc` · `.env.example` · `README.md` ·
`package.json` · `server/package.json` · `server/src/index.js` ·
`docker-compose.yml` · `render.yaml` *(pending Q5)*

**Modified:** `.env.example` (0.6) · `server/src/index.js` (0.7)

**Untracked, never committed:** `.env`

**Must remain untouched:** `PLAN.md` · `BACKLOG.md` · `CLAUDE.md` ·
`.claude/settings.json` · `docs/phases/` *(except this file)*

Needing a file not listed here is a stop condition.

## 8. Contracts and ownership

**`/health` response** — the only contract this phase creates:

```json
{ "status": "ok|degraded", "db": "ok|error", "redis": "ok|error" }
```

Returns 200 when both are ok, 503 when either fails. Phase 1.1 may move it but
must not change its shape without approval.

**Ownership rules:**
- `server/src/index.js` owns process bootstrap and `/health` **for this phase
  only**. Phase 1.1 takes over and restructures it.
- Phase 0 owns no schema, no tables, no migrations. `/health` runs `SELECT 1`
  and `PING` — nothing else.
- `.env.example` is the single source of truth for required variables. Anything
  reading an env var not listed there is a bug.

## 9. Architecture decisions

### D1 — Deploy before data stores
**Choice:** ship hello-world in 0.4, wire Postgres and Redis in 0.6.
**Why:** `PLAN.md` opens with "Deploy problems discovered at the end kill the
project." A failing deploy with no DB attached has one variable, not three.
**Rejected:** provisioning everything first — a common setup, but it turns the
first deploy failure into a three-way guess.

### D2 — Single-file server in Phase 0
**Choice:** everything in `server/src/index.js`; no `routes/`, `services/`, `db/`.
**Why:** that structure is Phase 1.1's deliverable. Building it here means Phase
1.1 either duplicates or silently inherits unreviewed decisions.
**Rejected:** full skeleton now — faster in the moment, but it moves work across
a phase boundary without an approval gate.

### D3 — `pg` for Postgres
**Choice:** the `pg` driver, raw SQL, per your decision.
**Why:** Phase 2.4 needs precise control of the transaction and the
constraint-violation catch; Phase 2.1 needs to assert the isolation level.
**Rejected:** Prisma or Knex — both abstract exactly the mechanism this project
exists to demonstrate.

## 10. Dependencies, schema, and protocol changes

**New packages — four, all runtime, none installed until you approve:**

| Package | Why required | Alternative considered |
|---|---|---|
| `express` | HTTP server; named in `PLAN.md` Phase 0 and 1.1 | Fastify — faster, but the plan says Express |
| `pg` | Postgres driver for raw SQL | `postgres.js` — nicer API, smaller ecosystem |
| `redis` | Redis client for `PING`, later holds | `ioredis` — see Q3 |
| `dotenv` | load `.env` in local dev | Node 20.6+ `--env-file` — see Q4 |

Manifests changed: `package.json` (root), `server/package.json`, and
`package-lock.json` on first install.

**Schema / migrations:** none. Phase 0 creates no tables.
**API / protocol changes:** `/health` only, defined in §8.

## 11. Security and reliability constraints

- No secrets committed. `.env` is gitignored from 0.2, before any credential
  exists. `.env.example` carries names and shapes, never values.
- Connection strings live only in the deploy host's env and local `.env`.
- `/health` reports status only — never versions, connection strings, or error
  detail that would leak topology.
- `/health` must fail fast with a short timeout, not hang, when a store is down.
  0.7's verification tests exactly this.
- Neon and Upstash both require TLS; connection config must not disable
  certificate verification to make it work.

## 12. Verification strategy

**Per module:** the two checks listed in §6.

**Phase-level, once all seven land:**
1. `curl <public-url>/health` → 200, both `ok`
2. `curl localhost:3000/health` against Docker → 200, both `ok`
3. Stop the local Redis container → `/health` reports `redis: error`, HTTP 503,
   and does not hang
4. Fresh clone into a temp dir + `npm ci` → boots from `.env.example` alone
5. `git status` → no `.env`, no `node_modules`

**Explicitly NOT verified in this phase:** query performance, connection pool
behaviour under load, cold-start behaviour beyond a single measurement, and
anything about seats, bookings, or holds. Phase 7 owns performance.

## 13. Measurements to record

One number, and it is not a benchmark:

- **What:** cold-start time to first 200 from the sleeping free tier
- **Command:** `time curl -s -o /dev/null -w '%{http_code}' <public-url>/health`
- **Environment:** deploy host and region, recorded alongside
- **Workload:** single request after ≥15 minutes idle
- **Sample count:** 3 cold starts, report the range not an average
- **Stored:** `README.md`, per `BACKLOG.md` P0

No throughput, latency, or concurrency claims come out of Phase 0. Those are
Phase 2 and Phase 7.

## 14. Risks, and what Phase 1 inherits

### R1 — The Windows npm leak (highest risk in this phase)

`npm` in WSL currently resolves to `/mnt/c/Program Files/nodejs/npm`. Installing
through it writes **Windows-native binaries** into a Linux project. It may look
fine until Phase 1.3, where `bcrypt` compiles native bindings and fails in a way
that reads like a code bug. 0.1 must fix the PATH and assert the fix, and no
`npm install` runs before that assertion passes.

### R2 — Docker daemon unreachable

The `docker` binary is the Docker Desktop shim and `docker info` fails. Until
this is resolved, 0.5 is blocked and so are all of Phase 2's benchmarks. See Q2.

### R3 — Free-tier cold starts

Render and Railway free tiers sleep. A recruiter hitting a 40-second cold start
sees a broken app. Mitigation is documentation, not engineering — `BACKLOG.md`
P0 already calls for it.

### Known limitations carried forward

Single instance; no CI; no refresh tokens (Phase 1.3); benchmarks local-only.

### Phase 1 inherits

A booting Express app on `main`, a local Docker Postgres and Redis, live cloud
credentials, and a `/health` contract. **Interfaces that must stay stable:** the
`/health` response shape, `.env.example` variable names.
**Must not change without approval:** raw SQL over an ORM; `server/` + `client/`
layout; deploy-before-data-stores ordering.

## 15. Decisions requiring approval

| ID | Decision | Recommendation | Alternatives |
|---|---|---|---|
| **Q1** | Node version. You chose **20.17.0**, but Node 20 reached end-of-life in April 2026 — no security patches. Ubuntu 26.04's apt candidate is 22.22.1, so 20.17.0 needs nvm or NodeSource regardless. | **Node 22 LTS** via nvm, pinned exactly in `.nvmrc` and `engines`. Active LTS, matches apt, one less moving part. | Keep 20.17.0 via nvm — works, but ships an EOL runtime in a portfolio project an interviewer may check |
| **Q2** | Docker in WSL. Daemon unreachable today. | **Enable Docker Desktop's WSL integration** for Ubuntu-26.04 — one checkbox, keeps one daemon | Install `docker.io` natively in WSL — fully independent of Windows, but two daemons and more setup |
| **Q3** | Redis client. Phase 4.1 needs Lua compare-and-delete. | **`redis`** (official node-redis) — first-party, scripting is sufficient | `ioredis` — nicer scripting ergonomics, third-party |
| **Q4** | `dotenv` or Node's built-in `--env-file`. | **`dotenv`** — works identically across local, Docker, and both deploy hosts | `--env-file` — one fewer dependency, but flag-passing differs per host |
| **Q5** | Deploy target — the plan says "Render or Railway". | **Render**, with a committed `render.yaml` so the deploy config is in version control and reviewable | Railway — faster setup, config lives in their dashboard |
| **Q6** | Does `client/` get scaffolded now? | **No** — create it in Phase 3.1, which owns the React shell | Scaffold an empty `client/` now for layout symmetry; costs a directory that sits unused for days |

## 16. Completion criteria

- [ ] All seven modules implemented
- [ ] Per-module and phase-level verification passes (§12)
- [ ] No out-of-scope changes — nothing from Phase 1 started
- [ ] Cold-start measured and in the README, or marked "Not measured"
- [ ] `README.md` reflects actual setup steps
- [ ] Known limitations recorded
- [ ] No secrets committed; `git status` clean of `.env` and `node_modules`
- [ ] Git state inspected, awaiting commit authorization

---

**No implementation begins until this plan is approved. No module plan is
written until this plan is approved.**

---

# Phase 0 — Close-out

**Status:** COMPLETE — awaiting commit authorization
**Completed:** 2026-08-18

## Built

- **0.1** WSL-native toolchain: Node v22.23.2 (nvm, pinned default), k6 v2.2.0, git 2.53.0, Docker via Desktop WSL integration.
- **0.2** `git init -b main`; `.gitignore`, `.nvmrc`, `.env.example`, `README.md`.
- **0.3** npm workspace root + `server/`; single-file Express serving `GET /`. ESM.
- **0.4** Deployed to Render (Singapore) from `render.yaml`; cold start measured.
- **0.5** `docker-compose.yml` — Postgres 17.11-alpine, Redis 7-alpine, healthchecks, named volumes.
- **0.6** Neon PostgreSQL 17 and Upstash Redis (both Singapore) wired into the Render environment.
- **0.7** `GET /health` reporting `{status, db, redis}`; 200 healthy / 503 degraded.

## Deviations from the approved plan

```
Plan said: node not installed in WSL; install Node 22.
Actual:    nvm was already present with v24.19.0; ~/.bashrc's non-interactive
           guard hid it from the shells used for inspection.
Why:       initial inspection ran non-interactive shells.
Approved:  reported before implementing; Q1 answer unchanged.
```

```
Plan said: local Postgres on 5432, Redis on 6379.
Actual:    5433 and 6380.
Why:       an unrelated project's containers (collab-postgres, collab-redis)
           already held the default ports. They were left running.
Approved:  reported in the 0.5 handoff.
```

```
Plan said: k6 installed via package manager.
Actual:    binary installed to ~/.local/bin.
Why:       k6 is not in Ubuntu 26.04's apt, and passwordless sudo is unavailable.
Approved:  reported in the 0.1 handoff.
```

```
Plan said: one commit at the end of the phase.
Actual:    five commits; the first mid-phase.
Why:       Render deploys from a git remote, so module 0.4 could not run
           without committed, pushed code. Deploy-before-data-stores (D1) is
           the reason Phase 0 exists.
Approved:  explicit workflow exception, then per-module commits.
```

```
Plan said: 0.7 modifies server/src/index.js only.
Actual:    also server/package.json and package-lock.json.
Why:       installing pg and redis, both pre-approved in §10. Deferred from 0.3
           so unused dependencies did not sit in the tree.
Approved:  flagged in the 0.3 handoff.
```

## Verification results

| Check | Result | Evidence |
|---|---|---|
| Toolchain WSL-native, no `/mnt/c` leak | PASS | `/tmp/verify01.sh` |
| Local stack healthy | PASS | `docker compose ps` — both healthy |
| Postgres round-trip over 5433 | PASS | write + read + cleanup |
| Redis round-trip over 6380 | PASS | SET/GET/DEL |
| `/health` healthy, local | PASS | `{"status":"ok","db":"ok","redis":"ok"}` 200 |
| `/health` degraded, Postgres down | PASS | 503, `db:error`, 11ms — no hang |
| `/health` degraded, Redis down | PASS | 503, `redis:error`, 5.0s |
| `/health` degraded, both down | PASS | 503, both `error` |
| Recovery after restart | PASS | returns to 200 |
| Process survives store outages | PASS | still running after all four cases |
| Fresh clone + `npm ci` | PASS | installs clean, no `.env` present |
| `/health` deployed | PASS | 200 `{"status":"ok","db":"ok","redis":"ok"}` |
| No secrets tracked | PASS | `.env` untracked; only `<password>` placeholders |
| No attribution, commits or files | PASS | scanned across all refs |

**Not verified:** query performance, pool behaviour under load, TLS certificate
pinning. Phase 7 owns performance.

## Measurements

**Cold start — 23.2 to 27.0 seconds** (3 samples: 24.418s, 23.163s, 27.006s).

- Command: `curl -s -o /dev/null -m 300 -w '%{time_total} %{http_code}' https://show-rush.onrender.com/health`
- Date: 2026-08-18, 17:48–18:38 UTC
- Method: 16 minutes enforced idle before each sample, service untouched between
- Environment: Render free tier (Singapore); Neon PostgreSQL 17 and Upstash Redis (Singapore)
- Sample count: 3
- Limitation: wall-clock from a residential connection in India. Includes network
  latency and database wake-up as well as container spin-up; these are not separated.

No other numbers were produced. Throughput, latency, and concurrency are **not measured**.

## Known limitations

- Free tier sleeps after ~15 minutes idle; first request pays the cold start above.
- Single instance. No CI (deliberate — `BACKLOG.md` P2).
- No refresh tokens (auth arrives in Phase 1.3).
- `/health` checks liveness only: `SELECT 1` and `PING`. It says nothing about schema, migrations, or capacity.
- Local ports are non-default (5433/6380). Phase 2 and Phase 7 benchmark methodology must record this, and `collab-*` should be stopped during benchmark runs so two Postgres instances are not competing for disk.

## Discovered, deferred

```
Issue: An unrelated project (collab-postgres, collab-redis) occupies ports
       5432/6379 on this machine.
Why out of scope: not this project's containers.
Recommended action: stop them during Phase 2 and Phase 7 benchmark runs so
       measurements are not contaminated by a second Postgres on the same disk.
```

```
Issue: Absent DATABASE_URL/REDIS_URL previously caused silent fallback to
       localhost defaults, connecting to a different project's Redis.
Why out of scope: fixed within 0.7 rather than deferred.
Recommended action: none — guarded. Worth remembering the failure mode.
```

## Handed to Phase 1

A booting Express app on `main`, deployed and reachable; local Postgres and Redis
via Docker; live cloud credentials in the Render environment; a `/health` contract.

**Stable interfaces:** `/health` response shape; `.env.example` variable names.
**Must not change without approval:** raw SQL over an ORM; `server/` + `client/`
layout; single-file server is Phase 1.1's to restructure, and only Phase 1.1's.

## Git state

Branch `main` at the Phase 0 merge, in sync with `origin/main`. Both module
branches (`module/0.6-cloud-data-services`, `module/0.7-health`) merged, retained
locally, never pushed. Remote carries only `refs/heads/main`.

## AWAITING COMMIT AUTHORIZATION

No commit created. No AI attribution trailers anywhere in history.
