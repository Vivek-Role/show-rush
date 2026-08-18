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

## Benchmarks

Not measured. Numbers land here in Phase 2 (booking contention, before and
after) and Phase 7, each with the command, environment, and workload used to
produce it. Until then this section stays empty rather than aspirational.

## Documentation

- `PLAN.md` — build plan, phase by phase
- `BACKLOG.md` — work deliberately cut, and why
- `docs/phases/` — per-phase plans and close-outs
