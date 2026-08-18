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
- [ ] **README benchmark table filled with YOUR measured numbers.**
      Never a number from a conversation or a blog post. Include how you
      measured: machine, DB version, concurrency level.
- [ ] **`loadtest/` scripts committed.** The scripts are the evidence. A metric
      without a reproducible script is a claim.
- [ ] **Architecture doc with rejected alternatives** — see P1 below if not done.
- [ ] **`.env.example`** with every required variable. No secrets committed.
- [ ] **Screenshot or 30s GIF in the README.** Most people never open the demo.

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

> If the Phase 3 baseline numbers were never recorded, record them first by
> checking out the pre-canvas commit. Without a "before," this work is unclaimable.

### Architecture decision doc
**Not deferred — it's Phase 8.2 in `PLAN.md`.** The six decisions and their
rejected alternatives are listed there. Don't duplicate the list here; one
canonical copy or they drift apart.
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

---

## P3 — Frontend depth

- [ ] **Optimistic selection with rollback** (if cut from Phase 6) — including
      correct handling of out-of-order responses
- [ ] **rAF-batched WebSocket updates** — 50 seat changes → 1 repaint
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
