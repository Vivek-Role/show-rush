# show-rush

Concurrent seat reservation system — the booking path for a cinema, built to be
correct under contention rather than merely functional.

**Status:** in development, Phase 0 (setup). Nothing here is measured yet.

## Prerequisites

- Node **v22.23.2** — `nvm use` reads `.nvmrc`
- Docker (Docker Desktop with WSL integration, or a native daemon)
- k6, for the load tests in `loadtest/`

## Setup

```bash
nvm use
cp .env.example .env   # then fill in DATABASE_URL and REDIS_URL
```

Local Postgres and Redis arrive in Module 0.5; the server in Module 0.3.

## Demo

<https://show-rush.onrender.com> — `/health` reports Postgres and Redis status.

**Cold start: 23.2–27.0 seconds.** The free tier sleeps after ~15 minutes idle,
so the first request after a quiet period is slow. Subsequent requests are
sub-second.

<details>
<summary>How that was measured</summary>

3 samples, each after 16 minutes of enforced idle time, taken 2026-08-18:

| Sample | Time | Result |
|---|---|---|
| 1 | 24.418s | HTTP 200 `{"status":"ok","db":"ok","redis":"ok"}` |
| 2 | 23.163s | HTTP 200 `{"status":"ok","db":"ok","redis":"ok"}` |
| 3 | 27.006s | HTTP 200 `{"status":"ok","db":"ok","redis":"ok"}` |

```
curl -s -o /dev/null -m 300 -w '%{time_total} %{http_code}' \
  https://show-rush.onrender.com/health
```

Render free tier, Singapore, against Neon PostgreSQL 17 and Upstash Redis, both
Singapore. Wall-clock from a residential connection in India, so it includes
network latency as well as container spin-up — the two are not separated here.

</details>

## Benchmarks

Not measured. Numbers land here in Phase 2 (booking contention, before and
after) and Phase 7, each with the command, environment, and workload used to
produce it. Until then this section stays empty rather than aspirational.

The cold-start figure above is a deployment characteristic, not a performance
benchmark of the system.

## Documentation

- `PLAN.md` — build plan, phase by phase
- `BACKLOG.md` — work deliberately cut, and why
- `docs/phases/` — per-phase plans and close-outs
