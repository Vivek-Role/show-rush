# Phase 3 — Seat map UI

**Status:** PLANNED — not implemented, not branched, not approved for implementation.
**Branch (proposed, not created):** `feat/seat-map`, from `main` @ `692ffcf`
**Source of truth:** `PLAN.md` §Phase 3, `BACKLOG.md`, `docs/phases/phase-2-booking-core.md`
**Rules:** `CLAUDE.md` — not restated here
**Plan written:** 2026-08-20
**Plan approved:** NOT YET — decisions Q1–Q10 in §17 are open

> Decisions D1–D8 were supplied by the user at planning time and are recorded in
> §16 as given. Q1–Q10 in §17 are what this plan discovered on top of them and
> cannot resolve on its own.

---

## Context

Phases 0–2 produced a backend that is correct under contention and a set of read
APIs written for exactly one consumer: this phase. Nothing has ever opened the
application in a browser. There is no `client/`, no CORS, and no frontend
dependency in the repository — the tree is still six server dependencies deep.

Phase 3 is the first phase whose output a human can look at. It is also the only
phase that produces a **frontend** measurement, and `BACKLOG.md` P1 states
plainly that without a recorded DOM baseline the canvas rewrite is unclaimable.
That makes 3.5 the load-bearing module of this phase, not the decoration at the
end of it.

The phase adds a client. It does not change how booking works, what a seat is,
or who decides whether a seat is taken.

---

## 1. Objective

Build a React + Vite client that browses the catalogue, renders a seat map from
the layout JSON, selects seats through a hook with no rendering logic in it,
shows a price breakdown, and books through the existing Phase 2 endpoint — then
record two reproducible frontend baseline numbers against a committed
5,000-seat dataset.

**Done when** (`PLAN.md`): browse shows, select seats, see a total — and two
reproducible baseline numbers are recorded.

---

## 2. User-visible outcome

A person opens the client and can:

1. See the list of movies.
2. Open a movie and see its shows, with screen name and start time.
3. Open a show and see the seat map — rows, seat numbers, aisles as gaps, tiers
   colour-coded, a legend, and seats already booked shown as unavailable.
4. Log in with the README demo account (or register), and stay logged in across
   a page refresh.
5. Select up to 6 available seats, see them highlighted, and see a running total
   with a per-tier breakdown.
6. Press a proceed button and get either a booking reference or a clear message
   that a seat was taken — the `SEATS_UNAVAILABLE` case, which is normal in
   Phase 3 because holds do not exist until Phase 4.

What they **cannot** do, on purpose: pay (Phase 5), hold seats (Phase 4), see
seat changes made by someone else without reloading (Phase 6), or view a list of
their past bookings (not planned — see §15).

---

## 3. Done-when criteria

- [ ] `client/` exists as a second npm workspace: React + React DOM + Vite +
      React Router, no state-management library
- [ ] `npm run dev --workspace client` serves a client that talks to a local
      server on a different port, through CORS, with no hard-coded backend URL
- [ ] Movie list → show list → seat map navigation works against the real API
- [ ] The seat grid renders from `screen.layout` and keys/selects by the seat
      `id` returned by the API, never by array position
- [ ] Seat status is treated as an open string set; an unknown status renders as
      not-selectable rather than crashing or being treated as available
- [ ] `useSeatSelection` contains the max-6 rule and the running total, and
      contains **no** JSX, no DOM access, and no `document`/`window` reference
- [ ] Booking summary shows a per-tier price breakdown computed in integer paise
- [ ] The proceed button calls `POST /api/bookings` and renders `201`,
      `409 SEATS_UNAVAILABLE`, and `401 UNAUTHENTICATED` distinctly
- [ ] Login survives a page refresh
- [ ] `npm run seed:stress` produces a documented ~5,000-seat screen **without
      destroying the normal demo dataset**, and is re-runnable
- [ ] `README.md` records **two** numbers — re-renders per seat click, and
      click-to-paint latency — each with machine, OS, browser + version, build
      mode, sample count, and the exact procedure, beside the seed command
- [ ] No change to booking semantics, no second availability path, no
      duplication of the Phase 2 endpoint's rules on the client
- [ ] `BOOKING_MODE=naive` and the naive path are untouched
- [ ] Phase 0/1/2 frozen contracts verified unchanged (§13)

---

## 4. Scope

### In scope

- `client/` — React + Vite app, routing, auth context, API client
- Seat grid rendered from layout JSON; tiers, aisles, legend
- `useSeatSelection` hook — select/deselect, max 6, running total
- Booking summary and the call to `POST /api/bookings`
- CORS on the server, origin from an environment variable
- Whichever authentication transport Q2 resolves to (§9)
- A **separate, additive** stress seed path and the `rowLabel()` fix it needs
- Two baseline measurements and their method, in `README.md`
- `docs/phases/phase-3-seat-map.md` (this file) and its close-out

### Out of scope

Anything below appearing in a diff is a stop condition.

| Excluded | Owner |
|---|---|
| Redis holds, TTL, countdown, `holdService` | Phase 4 |
| `'held'` as a status **produced** by the server | Phase 4.3 |
| Any second availability read | Phase 4.3 — `availabilityService` owns it |
| Payment, `payment_events`, idempotency | Phase 5 |
| Cancellation, refunds, reconciliation | Phases 5–6 |
| WebSockets, live seat updates, rAF batching, optimistic selection | Phase 6 |
| Canvas renderer, quadtree, viewport culling, zoom/pan | `BACKLOG.md` P1 — this phase produces its "before" |
| Conflict UX beyond a clear message; seat recommendation; mobile pinch-zoom; canvas a11y | `BACKLOG.md` P3 |
| Index tuning, pool sizing, dropping the redundant index | Phase 7.3b, approval-gated |
| Rate limiting, observability, CI | `BACKLOG.md` P2 |
| Automated test framework | Q7 — not adopted without separate approval |
| Refresh tokens, password reset, roles | Known limitations, not planned |
| Any change to `PLAN.md`, `BACKLOG.md`, `CLAUDE.md`, `.claude/`, `docker-compose.yml`, `.nvmrc` | control files — untouched |
| Creating or modifying the Render service or `render.yaml` | Q6 / §10.3 — Phase 3 designs it, authorization is separate |
| Any write to Neon or production data | never in this phase |
| Editing `docs/phases/phase-2-booking-core.md` | reported separately in §18, not changed here |

---

## 5. Module order

Strictly sequential. Each module depends on all its predecessors, and each stops
for approval before the next is planned.

```
3.1 → 3.2 → 3.3 → 3.4 → 3.5
```

The order is not arbitrary. 3.2 renders what 3.1 fetches. 3.3 extracts state out
of 3.2, and the extraction is only honest if 3.2 exists first — a hook designed
before its component is a guess. 3.4 consumes 3.3's output. 3.5 measures 3.2 and
3.3 under load, so it must run last, and it must run against the same code the
canvas version will later be compared with.

Per the working rules: each module gets its own implementation plan, reviewed and
approved before code, and the next module does not begin until the current one is
implemented, verified, and approved.

---

## 6. Modules

### 3.1 — App shell

**Goal.** A React + Vite client that can reach the API, route between pages, and
know whether someone is logged in — nothing about seats yet.

**Contents.**

- Vite scaffold as a second workspace, plain JavaScript (no TypeScript — Q4)
- React Router: `/` movies, `/movies/:id` shows, `/shows/:id` seat map, `/login`
- `AuthProvider` — plain React Context, no state library, exposing
  `{ user, login, register, logout, ready }`
- One API client module: base URL from `VITE_API_BASE_URL`, one place that parses
  the `{error:{code,message}}` envelope into a thrown error carrying `code`, so
  every screen branches on the code and never on a message string
- Server side: `cors` wired in `app.js` from a `CLIENT_ORIGIN` env var, and the
  authentication transport chosen in Q2

**Files.**

| File | Action |
|---|---|
| `client/package.json` | new |
| `client/vite.config.js` | new |
| `client/index.html` | new |
| `client/src/main.jsx` | new |
| `client/src/App.jsx` | new — routes |
| `client/src/api/client.js` | new — fetch wrapper, base URL, error envelope |
| `client/src/auth/AuthContext.jsx` | new |
| `client/src/pages/MoviesPage.jsx`, `ShowsPage.jsx`, `LoginPage.jsx` | new — minimal, filled in as later modules land |
| `client/.env.example` | new — `VITE_API_BASE_URL` |
| `.gitignore` | modify — `client/dist`, `client/.env` (Q5) |
| `package.json` (root) | modify — add `client` to `workspaces`, add client scripts |
| `package-lock.json` | modify — by `npm install`, authorized separately (Q1) |
| `server/src/app.js` | modify — mount `cors`, and cookie parsing if Q2 chooses cookies |
| `server/src/config/env.js` | modify — `clientOrigin`, plus cookie settings if Q2 chooses cookies |
| `server/src/routes/auth.js` | modify — only if Q2 chooses cookies |
| `server/src/middleware/auth.js` | modify — only if Q2 chooses cookies |
| `.env.example` | modify — `CLIENT_ORIGIN` (+ cookie vars if any) |
| `server/package.json` | modify — `cors` dependency |

**Done when.** The client builds, routes, calls `GET /api/movies` across origins
without a CORS error, and login + refresh both behave per §9.

---

### 3.2 — Seat grid

**Goal.** Render the seat map for a show from `GET /api/shows/:id/seatmap`.

**Contents.**

- `SeatMap` — takes `layout` and `seats`, renders rows in layout order
- Rows drawn from `layout.rows` (`{label, tier, seatNumbers}`); aisles from
  `layout.aislesAfterColumn` as gaps, not as fake seats
- Seats matched from the flat `seats` array by `(row_label, seat_number)` into a
  lookup built once per payload; the **`id` from that seat object is the
  identity** used for keys and selection
- Tier colour-coding + legend, driven by `layout.tiers`
- `status` handled as an open string: `available` is selectable; anything else
  (`booked` today, `held` from Phase 4, anything unknown) renders unselectable.
  A seat present in the layout but absent from `seats` renders as a gap, because
  `seats` is the authority on which seats exist
- Rendering only. No selection state lives here — that is 3.3.

**Files.**

| File | Action |
|---|---|
| `client/src/seatmap/SeatMap.jsx` | new |
| `client/src/seatmap/SeatButton.jsx` | new |
| `client/src/seatmap/Legend.jsx` | new |
| `client/src/seatmap/seatIndex.js` | new — pure `(layout, seats) → lookup` |
| `client/src/seatmap/seatmap.css` | new |
| `client/src/pages/SeatMapPage.jsx` | modify — fetch + render |

**Done when.** Show 1 renders its 160 seats (Audi 1 — 10 rows × 16) in the right
shape, with the seeded pre-booked seats visibly unavailable, and nothing in this
module holds selection state.

---

### 3.3 — `useSeatSelection`

**Goal.** All selection state in one hook, testable by reading it.

**Contents.**

```
useSeatSelection({ seats, maxSeats = 6 })
  → { selectedIds, isSelected(id), toggle(id), clear(),
      count, totalPaise, breakdown, limitReached }
```

- `toggle` refuses a seat whose status is not `available`, and refuses a 7th seat
  rather than silently dropping the oldest
- `totalPaise` is an integer sum of `price_paise`; no floats anywhere, and no
  division until the moment a rupee string is rendered
- `breakdown` groups by tier: `[{tier, count, unitPaise, subtotalPaise}]`
- Selection is keyed by seat `id` (string), never by index, never by
  `row_label + seat_number` as a synthetic key
- Selection drops ids that vanish from a refetched payload
- **Zero** rendering logic: no JSX, no DOM, no `window`, no `document`

`MAX_SEATS_PER_BOOKING = 6` already exists server-side in
`server/src/lib/validate.js` and is enforced there. The client repeats it as UX.
The server remains the enforcer — a limit only the browser enforces is not a
limit.

**Files.**

| File | Action |
|---|---|
| `client/src/seatmap/useSeatSelection.js` | new |
| `client/src/pages/SeatMapPage.jsx` | modify — own the hook, pass callbacks down |
| `client/src/seatmap/SeatMap.jsx` | modify — accept `isSelected` / `onToggle` as props |
| `client/src/money.js` | new — paise → display string, one function |

**Done when.** Selecting, deselecting, the 6-seat ceiling, and the running total
all work, and `useSeatSelection.js` contains no rendering.

---

### 3.4 — Booking summary

**Goal.** Turn a selection into a booking through the Phase 2 endpoint.

**Contents.**

- Summary panel: seat labels, per-tier breakdown, total, seat count
- Proceed button — disabled with nothing selected; when logged out, routes to
  login and returns to the same show
- `POST /api/bookings` with `{show_id, seat_ids}`
- Response handling, branching on the error **code**:

| Outcome | UI |
|---|---|
| `201` | booking reference, seat list, total, and an explicit "not paid yet — payment is Phase 5" note |
| `409 SEATS_UNAVAILABLE` | "one or more seats were just taken" + refetch the seat map + clear the lost seats from the selection |
| `401 UNAUTHENTICATED` | clear the session, route to login, keep the selection |
| `400 VALIDATION_ERROR` | show the message; this is a client bug and should not be reachable |
| `404 NOT_FOUND` | show is gone; back to the movie |
| `500` / network | generic failure, selection kept, retry allowed |

The client re-implements none of the endpoint's rules. It does not check
availability beyond what it already rendered, and it does not compute a price the
server will not honour — the total shown derives from the same `price_paise` the
seat map returned.

**Files.**

| File | Action |
|---|---|
| `client/src/booking/BookingSummary.jsx` | new |
| `client/src/booking/BookingResult.jsx` | new |
| `client/src/api/bookings.js` | new |
| `client/src/pages/SeatMapPage.jsx` | modify — wire summary + result |

**Done when.** A booking succeeds end-to-end against a local server, and a
deliberately raced 409 renders as a clear message with the seat map refreshed.

---

### 3.5 — Baseline measurement

**Goal.** Two frontend numbers a canvas rewrite can later be measured against,
produced by a committed dataset and a written procedure.

Two parts: the dataset (§11) and the measurement (§12). Both are described in
full in their own sections because both are where this phase can quietly become
indefensible.

**Files.**

| File | Action |
|---|---|
| `server/src/seed/layout.js` | modify — `rowLabel()` beyond 26 rows (§11.1) |
| `server/src/seed/stress.js` | new — additive stress seed, own entry point |
| `server/src/seed/data.js` | modify — export a `STRESS_SCREEN` spec (constants only) |
| `server/package.json` | modify — `"seed:stress"` script |
| `package.json` (root) | modify — `"seed:stress"` passthrough |
| `README.md` | modify — the two numbers, method, and the seed command |
| `docs/phases/phase-3-seat-map.md` | modify — close-out |

**Done when.** `npm run seed:stress` is re-runnable, the demo data is provably
untouched by it, and both numbers are in `README.md` with a procedure someone
else could follow.

---

## 7. Dependencies

**New, requiring authorization before any `npm install` (Q1):**

| Package | Where | Why |
|---|---|---|
| `react`, `react-dom` | `client` | D1 |
| `react-router-dom` | `client` | D1 — routing |
| `vite`, `@vitejs/plugin-react` | `client`, dev | D1 — build tool |
| `cors` | `server` | D2 |
| `cookie-parser` | `server` | **only if Q2 chooses cookies**; otherwise not added |

**Not added:** Redux, Zustand, Jotai, MobX, React Query, Axios, any CSS
framework, any component library, any form library, any date library, any test
framework. `fetch` is built in. Context plus a hook is the whole state model.

**Unchanged:** all six server dependencies. Nothing about Phases 0–2 needs a new
package.

Root `package.json` gains `client` in `workspaces` — a workspace-layout change,
which is why it is named here rather than done quietly.

---

## 8. API contracts consumed (Phase 1 / Phase 2)

Read from the code, not from the README.

**Error envelope** — every non-2xx under `/api`:
`{"error":{"code":"SCREAMING_SNAKE","message":"..."}}`. The code is stable; the
message is for humans. The client branches on `code` only.

| Method | Path | Auth | Response shape used |
|---|---|---|---|
| `GET` | `/api/movies` | none | `[{id, title, description, duration_minutes, language, certificate, poster_url}]` |
| `GET` | `/api/movies/:id/shows` | none | `{movie, shows:[{id, starts_at, screen:{id,name}}]}` |
| `GET` | `/api/shows/:id/seatmap` | none | `{show:{id,starts_at,movie:{...}}, screen:{id,name,cinema_name,layout}, seats:[{id,row_label,seat_number,tier,price_paise,status}]}` |
| `POST` | `/api/auth/register` | none | `201 {user:{id,email,name}, token}` · `409 EMAIL_TAKEN` · `400 VALIDATION_ERROR` |
| `POST` | `/api/auth/login` | none | `200 {user, token}` · `401 INVALID_CREDENTIALS` |
| `GET` | `/api/auth/me` | bearer | `200 {user}` · `401 UNAUTHENTICATED` |
| `POST` | `/api/bookings` | bearer | `201 {booking:{booking_ref, show_id, status, total_paise, seats:[{id,row_label,seat_number,tier,price_paise}]}}` · `409 SEATS_UNAVAILABLE` · `404 NOT_FOUND` · `400 VALIDATION_ERROR` · `401 UNAUTHENTICATED` |

`layout` shape, from `server/src/seed/layout.js`:

```
{ seatsPerRow, aislesAfterColumn: [n...], tiers: [...], rows: [{label, tier, seatNumbers: [1..n]}] }
```

**Ids are strings** in every response (`String(row.id)`), including seat ids.
**Prices are integer paise.** `starts_at` is an ISO timestamptz.

### Architectural constraints this phase inherits and must not bend

- **`seats` is authoritative for seat identity.** `screen.layout` is
  presentation/layout information. If they disagree, `seats` wins and the client
  draws a gap.
- **Selection uses the API seat `id`**, never array position.
- **`status` is an extensible string.** Phase 4 adds `held` without changing the
  response shape. The client must not model it as a boolean.
- **Max 6 seats**, enforced server-side; the client mirrors it for UX.
- **Prices are integer paise.**
- **The Phase 2 booking endpoint and its `SEATS_UNAVAILABLE` contract are
  consumed, not duplicated.** No availability logic moves to the client.
- **The naive booking path is an intentional Phase 2 measurement artifact.** It
  is not removed, hardened, or flagged. Phase 3 does not touch `bookingService`,
  `BOOKING_MODE`, or migration `002`.
- **`availabilityService` remains the only seat-status query path.**
- **No automated test framework** unless separately approved (Q7).

---

## 9. Authentication approach (D5)

### What exists today, verified in code

- `POST /api/auth/register` and `/login` return `{user, token}` in the JSON body
- `issueToken` signs HS256 with `sub = user.id`, lifetime `JWT_EXPIRES_IN` (7d)
- `requireAuth` reads `Authorization: Bearer <token>`, verifies, then loads the
  user by `sub` — a valid signature over a deleted user is not a session
- There is **no** cookie handling anywhere, no `cookie-parser`, no logout
  endpoint, and no refresh token
- `loadtest/seat-contention.js` authenticates with a **Bearer** header

### The constraint that decides this

D5 asks for httpOnly cookies **if clean**, no large rewrite, and survival across
refresh. The complication is not the cookie itself — it is that the client and
API sit on **different origins** in both environments:

| Environment | Client | API | Relationship |
|---|---|---|---|
| Local | `http://localhost:5173` | `http://localhost:3000` | cross-origin, same site |
| Deployed | `https://<client>.onrender.com` | `https://show-rush.onrender.com` | **cross-site** — `onrender.com` is on the Public Suffix List |

Cross-site means the cookie needs `SameSite=None; Secure`, which removes the CSRF
protection `SameSite` normally provides and requires a deliberate replacement.

### Recommended approach — additive cookie, Bearer preserved

**A1. `requireAuth` accepts Bearer *or* cookie, Bearer first.** Roughly six lines
added to `server/src/middleware/auth.js`. Every existing contract keeps working
unchanged — the k6 load test, the README `curl` examples, and anything Phase 5+
builds — because the Bearer path is untouched and still takes precedence.

**A2. Login and register additionally `Set-Cookie`.** `httpOnly`, `Secure`,
`SameSite=None` in production / `Lax` locally, `Path=/`, `Max-Age` matching the
token lifetime. The JSON body still returns `token`, so nothing that reads it
breaks. The browser client simply never touches that field.

**A3. `POST /api/auth/logout`** clears the cookie. A new endpoint — an API
contract addition, hence Q2.

**A4. CSRF defence for the cookie path.** Because `SameSite=None` is required
cross-site, cookie-authenticated **state-changing** requests must also carry a
custom header (`X-Requested-With: show-rush`). A custom header cannot be sent
cross-origin without a preflight the attacker's origin fails, so a forged
cross-site `POST /api/bookings` is rejected even with the cookie attached.
Bearer-authenticated requests are unaffected — a Bearer header is itself not
forgeable cross-site. Roughly ten lines.

**A5. Refresh survival.** On mount, `AuthProvider` calls `GET /api/auth/me` with
credentials. Cookie present and valid → logged in; otherwise → logged out.
`ready` stays false until that resolves, so the UI never flickers through a
logged-out state. **No token is ever stored in JavaScript**, so nothing sits in
`localStorage` for an XSS to read.

**Cost:** one dependency (`cookie-parser`, or ~8 lines of hand parsing — Q3), one
new endpoint, three modified server files, two new env vars. This is not an auth
rewrite: `server/src/services/authService.js` is **not modified at all**. Token
issuance, verification, hashing, and the user lookup are untouched.

### Fallback, if Q2 rejects the cookie

Bearer token in `localStorage`, restored on mount, validated by
`GET /api/auth/me`. Simpler, zero server change, but the token is readable by any
script on the page. That is the accepted trade if chosen — and it goes in the
README's known limitations, not left implied.

**Not proposed either way:** refresh tokens, session tables, rotating secrets, or
any change to how tokens are signed or verified.

---

## 10. CORS, environment, deployment

### 10.1 CORS (D2)

`cors` package, mounted before the routers in `server/src/app.js`:

```
origin:         config.clientOrigin      // exact string, from CLIENT_ORIGIN
credentials:    true                     // only if Q2 chooses cookies
methods:        GET, POST, OPTIONS
allowedHeaders: Content-Type, Authorization [, X-Requested-With]
```

`CLIENT_ORIGIN` is required — no wildcard, no hard-coded production URL, no regex
list. A wildcard is incompatible with credentialed requests anyway, so this is
both the simple and the correct configuration. If `CLIENT_ORIGIN` is unset the
server logs it the way missing connection vars are logged today, and cross-origin
browser requests fail closed.

### 10.2 Frontend environment configuration (D3)

- `VITE_API_BASE_URL` — the only client variable. Read once in
  `client/src/api/client.js`; every request is relative to it.
- Documented in a new `client/.env.example`. It is a **build-time** value baked
  into the bundle by Vite, which is why it lives beside the client rather than in
  the server's `.env`.
- Root `.env.example` claims to be the single source of truth for env vars. It
  gains `CLIENT_ORIGIN` (the server reads it) and a pointer line naming
  `client/.env.example` for client vars, so the claim stays true. Q5.
- The production backend URL appears in **no** committed client file. Local
  default is `http://localhost:3000`; production is supplied at build time.

### 10.3 Deployment architecture (D4)

```
Browser
  ├── https://<client>.onrender.com     Render Static Site
  │      React + Vite build output (client/dist)
  │      VITE_API_BASE_URL baked at build time
  │      SPA rewrite: /* → /index.html
  └── https://show-rush.onrender.com    existing Render Web Service
         Express, CLIENT_ORIGIN = the static site origin
             ↓                    ↓
          Neon Postgres      Upstash Redis
```

- The frontend is **not** served through Express. No `express.static`, no
  catch-all route, no build artifact committed or copied into `server/`.
- Adding the static site to `render.yaml` is a control-file change and a new
  service. **Not done in this phase's implementation modules.** It is designed
  here and authorized separately at the point of deployment (Q6).
- Build: `npm ci` at the root, `npm run build --workspace client`, publish
  `client/dist`. An SPA rewrite is required or a deep link to `/shows/1` 404s.
- Both origins must be known before either is configured: the static site needs
  `VITE_API_BASE_URL`, the API needs `CLIENT_ORIGIN`. Sequencing belongs to the
  deployment step, not to a module.
- **Nothing in Render or Neon is created, modified, or deployed during Phase 3
  implementation.**

---

## 11. Stress dataset (D7)

### 11.1 The `rowLabel()` problem, stated exactly

`server/src/seed/layout.js`:

```js
function rowLabel(index) {
  // Thirteen rows at most in this build, so a single letter is enough.
  return String.fromCharCode(65 + index);
}
```

At index 26 this emits `[`, then `\`, `]`, `^`, `_`, backtick, then lowercase. A
5,000-seat screen needs roughly 100 rows. Beyond the cosmetic problem, those
characters break `parseSeatSpec` in `seed/index.js` (`/^([A-Z]+)(\d+)$/`) and
would put punctuation into `seats.row_label`, which is the authoritative table.

**Simplest correct fix — bijective base-26:** `A…Z, AA, AB, … AZ, BA, …`

```js
function rowLabel(index) {
  let label = '';
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) {
    label = String.fromCharCode(65 + (n % 26)) + label;
  }
  return label;
}
```

Six lines, pure, no dependency. Two properties matter:

1. **Indices 0–25 are unchanged** (`A`–`M` for the existing 13-row maximum), so
   the normal seed produces byte-identical data. This must be **verified, not
   assumed** — by comparing seat rows before and after the change.
2. Output stays `^[A-Z]+$`, so `parseSeatSpec` and the existing
   `unique (screen_id, row_label, seat_number)` keep working untouched.

Rejected: `A1`-style numeric rows and zero-padded `R001` (both change existing
labels), and a `rowLabels` array in config (a second source of truth for
something a function derives).

### 11.2 Additive stress seed

**The finding that shapes this.** `server/src/seed/index.js` begins with
`TRUNCATE booking_seats, bookings, show_prices, shows, seats, screens, movies,
users RESTART IDENTITY CASCADE`. A stress seed built on that machinery would
destroy the demo dataset, which D7 forbids.

**Approach — `server/src/seed/stress.js`, a separate entry point that never
truncates:**

1. Delete only what a previous stress run created, resolved by the literal screen
   name `Stadium (stress)`: bookings on its shows, then its shows, then the
   screen (seats cascade from the screen). Nothing else is ever in scope.
2. Insert one screen `Stadium (stress)` — **100 rows × 50 seats = 5,000 seats**,
   tier bands and aisle positions as constants in `data.js` (Q10).
3. Insert one show on it, using an existing movie, plus its `show_prices`.
4. Print the show id and the seat count, so the measurement procedure can name
   the exact URL it profiled.
5. One transaction, like the normal seed. Same `NODE_ENV=production` refusal.

Properties: additive (demo data untouched), re-runnable (step 1 is idempotent and
scoped to rows this script owns), reproducible (every input a constant), and
documented (README, beside the numbers).

The scoped delete in step 1 is destructive in the narrow sense, over rows the
script itself created. Flagged as **Q8** rather than assumed.

**Alternative, if Q8 rejects the scoped delete:** a separate database, as Phase 2
did for the naive baseline. Provably non-destructive, but it requires restarting
the server against a different `DATABASE_URL`, which makes the measurement
procedure longer and easier to get wrong.

---

## 12. Baseline measurement methodology (D8)

### 12.1 The two numbers — kept apart on purpose

| # | Number | What it means | Tool |
|---|---|---|---|
| 1 | **Re-renders per seat click** | How many components React re-rendered for one click on one seat, at 5,000 seats | React DevTools Profiler — commits, and components rendered per commit |
| 2 | **Click-to-paint latency (ms)** | Wall time from the click input event to the next paint reflecting it | Chrome DevTools Performance panel — `click` event → paint on the same interaction |

They are different claims. #1 is what the canvas rewrite is expected to change
structurally; #2 is what a user feels. Reporting one as the other, or a single
merged "performance" figure, would be exactly the kind of unfalsifiable claim
`CLAUDE.md` §6 forbids.

### 12.2 The conflict D8 has to resolve — production build vs Profiler

D8 requires a production build. React's production build **strips the profiling
hooks**, and React DevTools then reports that profiling is unavailable. The two
requirements are in genuine tension, and this is not something to discover
halfway through a measurement.

**Proposed resolution (Q9):** a production build **with profiling enabled** —
Vite `resolve.alias` mapping `react-dom` to React's profiling build, minified,
`NODE_ENV=production`. This keeps every production characteristic that matters
(no dev-mode double-render, no dev warning paths, minified code) while leaving
the Profiler able to attach. The profiling build carries a small overhead, which
is recorded with the number.

**If that proves unworkable in practice**, the fallback is to source the two
numbers from different builds and say so plainly:

- **#1 re-renders** from a profiling-enabled build (a structural count; build
  mode does not change *how many* components re-render)
- **#2 click-to-paint** from the plain production build (a timing number, which
  must come from production code)

Each number then carries its own build mode in the README. What will **not**
happen is one build silently standing in for the other.

### 12.3 Procedure (executed in Module 3.5, not before)

1. `npm run seed:stress` — record the printed show id and seat count
2. Build the client per §12.2; serve the built output (`vite preview` or a static
   server) — **never the dev server**
3. Fixed browser, exact version recorded, fresh profile, no extensions except
   React DevTools, no other tabs, machine on mains power
4. Open the stress show, wait for the map to settle
5. **Number 1:** start the Profiler, click one available seat, stop. Record
   commits and components rendered per commit. Repeat on **10** distinct
   available seats.
6. **Number 2:** Performance panel recording, click one available seat, stop.
   Measure click event → paint. Repeat **10** times.
7. Report **median and full range** for both — never a single figure, and never a
   mean over a distribution nobody looked at
8. Record: machine, cores, RAM, OS + version, Node version, browser + exact
   version, React version, build mode, seat count, show id, commit SHA, date,
   sample count

### 12.4 What these numbers are not

They are single-point client-side measurements on one machine and one browser.
They are **not** throughput, **not** capacity, **not** a server benchmark, and
**not** a claim about any other device. No number enters `README.md` from an
estimate or a recollection. Anything not measured is written **"Not measured."**

---

## 13. Verification strategy

Targeted, per `CLAUDE.md` §6. No test framework is adopted (Q7); verification is
scripted HTTP, SQL, and browser checks, as in Phases 1 and 2.

| Module | Verification |
|---|---|
| 3.1 | Client builds; `GET /api/movies` succeeds cross-origin in a browser; a request from a disallowed origin is blocked; login works; **refresh keeps the session**; `curl` with a Bearer token still works unchanged |
| 3.2 | Show 1 renders 160 seats matching the API payload; pre-booked seats show unavailable; a hand-injected unknown status renders unselectable rather than available |
| 3.3 | Select, deselect, 7th seat refused, total matches a hand-computed paise sum; grep confirms no JSX/DOM/`window` in the hook |
| 3.4 | Booking succeeds and returns a ref; a deliberately raced 409 (book the same seat by `curl` first) renders the conflict message and refreshes the map; an invalid session renders the login path |
| 3.5 | Stress seed run twice → identical result; demo dataset row counts identical before and after (SQL, recorded); both numbers measured per §12 |

**Not re-run:** Phase 2's contention suite. Phase 3 changes no booking code, so
re-running it would produce a number that measures nothing new. Phase-level
verification happens at close-out.

**Never claimed by this phase:** throughput, capacity, hold behaviour, WebSocket
anything, multi-instance correctness, production performance, or that any number
here describes a machine other than the one it was measured on.

---

## 14. Risks and constraints

| # | Risk | Handling |
|---|---|---|
| R1 | `rowLabel()` silently changing existing labels | Verify indices 0–25 byte-identical before the stress seed is written (§11.1) |
| R2 | The stress seed destroying demo data | Additive path, scoped delete, row counts compared before/after (§11.2, Q8) |
| R3 | Profiler unavailable in a production build | Resolved up front in §12.2 (Q9), not discovered mid-measurement |
| R4 | Cross-site cookies and CSRF | `SameSite=None; Secure` plus a required custom header on cookie-authenticated writes (§9 A4) |
| R5 | Cookie change breaking the Bearer contract | Bearer path untouched and takes precedence; `authService.js` not modified; k6 script unaffected |
| R6 | 5,000 DOM nodes making the browser sluggish | That is the point — it is the "before". If it is unusable, that is a finding to record, not a bug to fix in Phase 3 |
| R7 | Selection state creeping into components | 3.3 exists to prevent it; verification greps for it. `BACKLOG.md` P1's canvas swap depends on this split |
| R8 | No holds until Phase 4, so a selected seat can be taken mid-selection | Expected. The 409 path is the design, not a workaround |
| R9 | Scope creep into Phase 4/6 (countdowns, live updates, optimistic UI) | Listed out of scope in §4; any appearance is a stop condition |
| R10 | Client and API origins are mutually dependent at deploy time | Sequenced at the deployment step (§10.3), not inside a module |
| R11 | Workspace change affecting the server build | Root `package.json` gains a workspace; Render's `npm ci` + `npm start` path must be re-verified before any deploy |
| R12 | `starts_at` rendering in the wrong timezone | Times are timestamptz; the client formats in the viewer's locale and labels it |

**Carried, unchanged, from earlier phases:** `bookings.updated_at` has no trigger
or writer until Phase 5; `isId` still lives in `catalogService`; services do not
guard a null `pool`; seeded day-0 shows can be in the past; the
`booking_seats_show_id_seat_id_idx` index is redundant (Phase 7.3b); the `pg`
`sslmode=require` deprecation warning.

---

## 15. Deliberate omissions

- **No `GET /api/bookings`.** A booking is visible through its creation response
  only. A bookings list is an API addition nobody has approved, and Phase 3's
  done-when does not need it.
- **No admin UI** — the seed script is the admin UI (`PLAN.md`).
- **No test framework** — consistent with Phases 1 and 2 (Q7).
- **No TypeScript** — the server is plain JavaScript; a split-language repo for
  one phase is not simplicity (Q4).
- **No CSS framework, no component library.** Hand-written CSS. A seat grid is a
  grid.
- **No accessibility work beyond native semantics** — seats are `<button>`
  elements with labels, which is free. Canvas a11y is `BACKLOG.md` P3.

---

## 16. Decisions supplied by the user (D1–D8)

| ID | Decision |
|---|---|
| **D1** | React + React DOM + Vite + React Router. No Redux/Zustand/other state library. Plain Context for auth, a custom hook for seat selection. No unnecessary dependencies. |
| **D2** | Use the `cors` package. Frontend origin from an env var, never a hard-coded production URL. Simple and explicit. |
| **D3** | `VITE_API_BASE_URL`. No hard-coded backend URL in the frontend. Client env var documented clearly. |
| **D4** | Separate React/Vite frontend deployed as a Render Static Site. Not served through Express. Render not created or modified yet; authorization at the appropriate step. |
| **D5** | Prefer httpOnly cookies if cleanly implementable against the existing auth. No large auth rewrite. Inspect Phase 1 auth first and document the exact approach. Must survive refresh. → §9 |
| **D6** | Branch `feat/seat-map`. Not created until the plan is reviewed and explicitly approved. |
| **D7** | Normal/demo seed unchanged. Separate stress path for the 5,000-seat layout. Nothing destroyed. Reproducible and documented. `rowLabel()` addressed with the simplest correct fix. → §11 |
| **D8** | Production build, fixed browser + version, machine/OS/browser/build recorded, React DevTools Profiler for re-renders, two clearly distinguished numbers, sample count and exact procedure documented, no throughput/capacity claims. → §12 |

---

## 17. Open questions — required before Module 3.1

| ID | Question | Recommendation |
|---|---|---|
| **Q1** | Authorize `npm install` for React, React DOM, React Router, Vite, `@vitejs/plugin-react`, `cors` (+ `cookie-parser` if Q2 says cookies), and the resulting `package-lock.json` change? | Approve — D1/D2 already chose them; this is the authorization to actually install |
| **Q2** | Cookie auth per §9 (accepts an added `POST /api/auth/logout`, a CSRF header requirement, and cookie env vars) — or the `localStorage` Bearer fallback? | **Cookie, additive.** It meets D5, keeps every existing contract, and never exposes a token to JavaScript |
| **Q3** | `cookie-parser` dependency, or ~8 lines of hand parsing? | `cookie-parser` — one well-understood package beats hand-rolled header parsing on an auth path |
| **Q4** | Plain JavaScript for the client, matching the server? | Yes — plain JS |
| **Q5** | Add `CLIENT_ORIGIN` to root `.env.example` plus a pointer to `client/.env.example`, and add `client/dist` + `client/.env` to `.gitignore`? (`.gitignore` is a control file) | Approve — the alternative is a `.env.example` that no longer tells the truth |
| **Q6** | Confirm `render.yaml` and the Render dashboard stay untouched through 3.1–3.5, with deployment authorized separately afterwards? | Approve — matches D4 |
| **Q7** | Confirm no test framework in Phase 3? | Confirm — consistent with Phases 1 and 2 |
| **Q8** | Approve the scoped delete in the stress seed (bookings → shows → screen, matched on the literal name `Stadium (stress)`), or use a separate database instead? | Scoped delete — it is what makes the script re-runnable, and it only ever touches rows the script created |
| **Q9** | Approve §12.2's production-build-with-profiling, and the documented fallback of sourcing the two numbers from different builds if it fails? | Approve — the alternative is discovering the conflict mid-measurement |
| **Q10** | Stress screen shape: 100 rows × 50 seats = 5,000 seats, one show, existing movie, three tier bands? | Approve, or name a different shape now — it is baked into the recorded baseline and cannot change afterwards without invalidating it |

---

## 18. Reported separately — not changed by this plan

```
Plan says:  docs/phases/phase-2-booking-core.md — header "Status: ... Not merged",
            branch @ 2c028b6; §22 gate table lists gate 3 (README benchmark table),
            gate 5 (002 applied to Neon), gate 6 (Render BOOKING_MODE check) and
            gate 7 (merge, deploy, production verification) as NOT DONE or
            REQUIRES AUTHORIZATION.

Actual:     Verified 2026-08-20 — 65c1520 added the README benchmark table;
            main @ 692ffcf is the merge commit for feat/booking-core @ 65c1520,
            in sync with origin/main; Neon reports schema_migrations =
            001_init.sql, 002_unique_booking_seats.sql with constraint
            booking_seats_show_id_seat_id_key present; the deployed service
            answers 200 {"status":"ok","db":"ok","redis":"ok"}.
            Gate 6 is NOT VERIFIED — Render's environment was not inspected.

Recommend:  A small close-out amendment to that document's status header and §22
            gate table, marking gates 3, 5 and 7 PASS with the date and leaving
            gate 6 open. Historical plan text stays exactly as written.

Status:     NOT DONE. Requires explicit approval; it is Phase 2 documentation and
            outside Phase 3's approved scope.
```

---

## 19. Close-out requirements

Phase 3 is not complete until:

1. All five modules implemented, each verified per §13 and approved individually
2. `README.md` updated — the client, its setup, `VITE_API_BASE_URL`,
   `CLIENT_ORIGIN`, the demo flow, the two baseline numbers with full method and
   the `seed:stress` command beside them, and any new known limitation (auth
   transport, CSRF approach, 5,000-seat behaviour)
3. This document extended with a close-out recording: what was actually
   implemented, every deviation from this plan marked inline as **superseded**
   with the reason, verification results labelled PASS / FAIL / NOT RUN /
   NOT VERIFIED / INFERRED, decisions taken during implementation, and open
   issues handed to Phase 4
4. A Phase 0/1/2/3 integration review — frozen contracts unchanged, no
   cross-phase leakage, no Phase 4+ code present, `BOOKING_MODE=naive` intact
5. Git hygiene confirmed — one author, no AI attribution, no tracked secrets,
   clean tree, no unplanned files
6. **One commit at the end of the phase** unless separately directed, on
   `feat/seat-map`, authorized explicitly
7. Merge, deployment of the static site, and `CLIENT_ORIGIN` configuration
   authorized **separately** and **after** the above — never as part of a module

---

## 20. What Phase 3 hands to Phase 4

- A seat grid whose `status` handling already accepts `held` without a shape
  change
- A selection hook with zero rendering in it — the seam the countdown (4.4) and
  `BACKLOG.md` P1's canvas renderer both attach to
- A working browser client, which is what makes 4.5's "two tabs cannot hold the
  same seat" verifiable at all
- A committed 5,000-seat dataset and a recorded DOM baseline
- `availabilityService` still the single seat-status path, untouched

---

## 21. Module 3.1 — App shell · implementation plan (approved)

> Approved 2026-08-20, ahead of implementation. Sections 1–20 above are the
> phase plan and are not rewritten by this section. Deviations discovered during
> implementation are recorded in §21.9, not by editing the text above.

### 21.1 Goal

A React + Vite client that reaches the API cross-origin, routes between pages,
and knows who is logged in — across a refresh. No seats yet.

### 21.2 Approved file scope

**New — client**

| File | Contents |
|---|---|
| `client/package.json` | `@show-rush/client`, private, `type: module`; scripts `dev`, `build`, `preview` |
| `client/vite.config.js` | `@vitejs/plugin-react`; ports pinned with `strictPort` — `CLIENT_ORIGIN` must match exactly, and a dev server that silently moves ports breaks CORS in a way that looks like a code bug |
| `client/index.html` | root div + module script |
| `client/src/main.jsx` | `createRoot` → `BrowserRouter` → `AuthProvider` → `App` |
| `client/src/App.jsx` | routes `/`, `/movies/:id`, `/login` |
| `client/src/api/client.js` | base URL, fetch wrapper, error envelope, `ApiError` |
| `client/src/auth/AuthContext.jsx` | `AuthProvider` + `useAuth` |
| `client/src/pages/MoviesPage.jsx` | movie list — the screen that proves CORS works |
| `client/src/pages/ShowsPage.jsx` | movie + its shows |
| `client/src/pages/LoginPage.jsx` | login / register form |
| `client/.env.example` | `VITE_API_BASE_URL` |

**New — server**

| File | Contents |
|---|---|
| `server/src/lib/auth-cookie.js` | the single definition of the session cookie: name, options, set, clear |

**Modified**

| File | Change |
|---|---|
| `package.json` | `workspaces: ["server", "client"]`; add `dev:client`, `build:client`, `preview:client` |
| `package-lock.json` | regenerated by the authorized install |
| `.env.example` | add `CLIENT_ORIGIN` and a pointer to `client/.env.example` |
| `server/package.json` | add `cors`, `cookie-parser` |
| `server/src/config/env.js` | add `clientOrigin` |
| `server/src/app.js` | mount `cors` + `cookieParser` |
| `server/src/routes/auth.js` | set the cookie on register/login; add `POST /logout` |
| `server/src/middleware/auth.js` | accept a cookie as fallback; enforce the CSRF header on cookie-authenticated writes |
| `server/src/index.js` | startup warning when `CLIENT_ORIGIN` is unset |

**Explicitly untouched:** `bookingService`, `availabilityService`, `catalogService`,
**`authService.js`**, `routes/bookings.js`, `routes/movies.js`, `routes/shows.js`,
migrations, `loadtest/`, `render.yaml`, `docker-compose.yml`, `.gitignore`,
`PLAN.md`, `BACKLOG.md`, `CLAUDE.md`, `.claude/`,
`docs/phases/phase-2-booking-core.md`.

### 21.3 Rulings taken before implementation

- **`server/src/lib/auth-cookie.js` is added** (approved). The cookie name and
  options are needed by both the auth routes and the auth middleware, and a
  cookie cleared with attributes that do not match how it was set is not cleared
  at all — a silent failure. One definition, two importers.
- **No `/shows/:id` stub** (approved). The route and `SeatMapPage` arrive
  together in Module 3.2. A show in the list is deliberately not yet clickable.
- **`.gitignore` is not modified** (approved). Verified with
  `git check-ignore -v`: `dist/` already matches `client/dist` at any depth,
  `.env` already matches `client/.env`, and `!.env.example` keeps
  `client/.env.example` trackable. Adding explicit entries would be redundant.
- **No CSS file.** The shell is unstyled; `seatmap.css` belongs to Module 3.2.

### 21.4 CORS

```js
app.use(cors({
  origin: config.clientOrigin,          // exact string from CLIENT_ORIGIN
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));
```

No wildcard, no regex, no list — a wildcard is incompatible with credentialed
requests anyway, and the browser client sends its cookie on every call. An unset
`CLIENT_ORIGIN` is reported at startup and not fatal: browsers fail closed,
while `curl` and k6 are unaffected, because CORS is a rule browsers apply to
themselves.

### 21.5 The session cookie

| Attribute | Value |
|---|---|
| name | `sr_token` |
| `httpOnly` | `true` — always |
| `secure` | `nodeEnv === 'production'` |
| `sameSite` | `'none'` in production (cross-site: `onrender.com` is a public suffix), `'lax'` locally |
| `path` | `/` |
| `maxAge` | derived from the issued token's own `exp` claim via `jwt.decode` |

`maxAge` is read off the token that was just issued rather than parsed from
`JWT_EXPIRES_IN`. One source of truth, no duration parsing, and no second
constant that can drift from the token's real lifetime.

### 21.6 `requireAuth`

```
1. Authorization: Bearer <token>  → use it, viaCookie = false
2. else req.cookies.sr_token      → use it, viaCookie = true
3. neither                        → 401 UNAUTHENTICATED   (unchanged)
4. if viaCookie and method not in {GET, HEAD, OPTIONS}
     and X-Requested-With !== 'show-rush'
   → 403 CSRF_HEADER_REQUIRED
```

Bearer is checked first and is deliberately exempt from step 4: an
`Authorization` header cannot be attached to a cross-site request by a form
post, so it carries its own proof of intent. That precedence is what keeps
`loadtest/seat-contention.js` and every documented `curl` example working
byte-for-byte. `verifyToken` and `findUserById` are called exactly as before —
`authService.js` is not opened.

### 21.7 Approved API additions

| Addition | Shape |
|---|---|
| `POST /api/auth/logout` | `204`, clears the cookie. Unauthenticated by design: clearing an already-expired session is a success, not a 401 |
| `403 CSRF_HEADER_REQUIRED` | new error code, cookie-authenticated writes only |
| `Set-Cookie` on register/login | added; the JSON `{user, token}` body is unchanged |

### 21.8 Client rules

- `VITE_API_BASE_URL` is read once, at module load, and the module throws if it
  is absent — a bundle built without it would otherwise fall back to its own
  origin and 404 every call, which reads as a routing bug rather than a build
  misconfiguration
- every request sends `credentials: 'include'`
- every non-GET sends `X-Requested-With: show-rush`
- the `token` in the login response is ignored by the browser client
- **nothing is written to `localStorage` or `sessionStorage`**
- `AuthProvider` resolves the session once on mount via `GET /api/auth/me` and
  holds `ready` false until it does, so the UI never flashes a logged-out state

### 21.9 Verification

Recorded in the Module 3.1 close-out (§22), with results labelled PASS / FAIL /
NOT RUN / NOT VERIFIED / INFERRED. No test framework is added.

---

## 22. Module 3.1 — close-out

**Status:** IMPLEMENTED and VERIFIED. Not committed, not pushed, not merged.
**Branch:** `feat/seat-map`, from `main` @ `692ffcf`
**Written:** 2026-08-20

### 22.1 What was implemented

Exactly the approved file scope in §21.2, plus the one added server file
approved as ruling (a). No file outside that list was modified.

**New — client:** `package.json`, `vite.config.js`, `index.html`,
`.env.example`, `src/main.jsx`, `src/App.jsx`, `src/api/client.js`,
`src/auth/AuthContext.jsx`, `src/pages/MoviesPage.jsx`,
`src/pages/ShowsPage.jsx`, `src/pages/LoginPage.jsx`.

**New — server:** `src/lib/auth-cookie.js`.

**Modified:** `package.json`, `package-lock.json`, `.env.example`,
`server/package.json`, `server/src/config/env.js`, `server/src/app.js`,
`server/src/routes/auth.js`, `server/src/middleware/auth.js`,
`server/src/index.js`.

**Untouched, as required:** `authService.js`, `bookingService`,
`availabilityService`, `catalogService`, `bookings.js`, `movies.js`,
`shows.js`, migrations, `loadtest/`, `render.yaml`, `docker-compose.yml`,
`.gitignore`, `PLAN.md`, `BACKLOG.md`, `CLAUDE.md`, `.claude/`, and
`docs/phases/phase-2-booking-core.md`.

### 22.2 Dependencies

The seven approved packages, and nothing else:

| Package | Version | Workspace |
|---|---|---|
| `react` | 19.2.8 | client |
| `react-dom` | 19.2.8 | client |
| `react-router-dom` | 7.18.2 | client |
| `vite` | 8.2.2 | client (dev) |
| `@vitejs/plugin-react` | 6.1.0 | client (dev) |
| `cors` | 2.8.6 | server |
| `cookie-parser` | 1.4.7 | server |

**Every pre-existing server dependency is unchanged**, verified against a
snapshot taken before the install: `bcryptjs` 3.0.3, `dotenv` 17.4.2,
`express` 5.2.1, `jsonwebtoken` 9.0.3, `pg` 8.23.0, `redis` 6.2.1.

### 22.3 Verification results

Local: WSL2 Ubuntu, Node **v22.23.2** (the pinned version), local Docker
Postgres 17 and Redis, API on port 3000/3100, client build served by
`vite preview`. Browser: Chrome (extension-driven).

| # | Check | Result |
|---|---|---|
| 1 | Client production build | **PASS** — 28 modules, `dist/assets/index-*.js` 234.08 kB (74.94 kB gzip) |
| 2 | Browser reaches API cross-origin, no CORS error | **PASS** — 5 movies rendered from `:4173` against `:3000` |
| 3 | Evil origin refused | **PASS**, criterion corrected — see 22.4 |
| 4 | Login sets HttpOnly cookie | **PASS** — `sr_token=…; Max-Age=604799; Path=/; HttpOnly; SameSite=Lax` |
| 5 | `document.cookie` cannot read `sr_token` | **PASS** — verified in the browser, cookie absent from `document.cookie` while the session was active |
| 6 | Refresh preserves the session | **PASS** — full page load, still signed in as `demo@show-rush.dev` |
| 7 | Logout clears authentication | **PASS** — 204, header returns to "Log in", still logged out after reload; `/api/auth/me` → 401 |
| 8 | Bearer authentication unchanged | **PASS** — `GET /api/auth/me` with Bearer → 200 |
| 9 | Bearer POST without `X-Requested-With` | **PASS** — 201, booking `SR-1A0K4RY3EW` created |
| 10 | Cookie POST without `X-Requested-With` | **PASS** — 403 `CSRF_HEADER_REQUIRED` |
| 11 | Cookie POST with `X-Requested-With` | **PASS** — 201, booking `SR-0X3A3BYVR6` created |
| 12 | Missing `CLIENT_ORIGIN` | **PASS** — logs `CLIENT_ORIGIN is not set — browser clients will be blocked by CORS`, starts normally |
| 13 | No production URL committed in `client/` | **PASS** — no match for `onrender` |

**NOT RUN:** Phase 2's contention suite — no booking code changed, so re-running
it would measure nothing new.

**NOT VERIFIED:** production cookie behaviour (`SameSite=None; Secure`
cross-site). It cannot be exercised until the static site is deployed, and
belongs to the deployment step. It is not claimed here.

### 22.4 Check 3 — the criterion was wrong, not the code

§21 stated the expected result as "no `Access-Control-Allow-Origin` header".
That is the behaviour of a *function* origin that rejects. With a fixed-string
origin, the `cors` package always echoes the **configured** origin regardless of
what the request asked for.

Observed with `Origin: http://evil.example`:
`Access-Control-Allow-Origin: http://localhost:5173`.

The security property holds — the evil origin never receives an allow-origin
matching itself, so the browser blocks the response. The correct criterion,
recorded here for re-runs, is **"ACAO never equals the requesting origin when
that origin is not `CLIENT_ORIGIN`"**. No code was changed for this.

### 22.5 Defect found and fixed during verification

`ShowsPage.jsx` built its `Intl.DateTimeFormat` with `dateStyle` and
`timeStyle` **together with** `timeZoneName`. ECMA-402 forbids combining the
shorthand styles with individual component options, so the constructor threw
`Invalid option : option` at **module scope** — which made importing
`ShowsPage.jsx` fail, which made `App.jsx` fail, so React never mounted and the
page rendered an empty `#root` with no console error.

Fixed by spelling the fields out (`year`, `month`, `day`, `hour`, `minute`,
`timeZoneName`). Re-verified: the shows route renders
`Aug 20, 2026, 02:00 AM GMT+5:30 · Audi 1`.

Worth recording because HTTP-level checks would never have caught it. Only
loading the app in a real browser did.

### 22.6 Deviations from the approved plan

1. **`.gitignore` left untouched** (ruling (c)). The existing `dist/`, `.env`
   and `!.env.example` patterns already cover `client/dist`, `client/.env` and
   `client/.env.example` at any depth — confirmed with `git check-ignore -v`.
   The authorization to modify it went deliberately unused.
2. **Verification ports.** Port 5173 was already occupied by an unrelated Vite
   dev server belonging to another project. `strictPort: true` refused to move
   rather than silently picking another port — the intended behaviour. The other
   process was left alone and verification ran on 5174 (dev) and 4173 (preview),
   with `CLIENT_ORIGIN` set to match.
3. **Browser interaction was driven programmatically.** The browser extension's
   screenshot and accessibility-tree tools could not attach to these localhost
   pages (`document_idle` never fired). Form fill used native value setters plus
   `form.requestSubmit()`, so React's own submit handler and `AuthContext.login`
   ran for real; only the synthetic mouse input is absent.

### 22.7 Local side effects

- Two bookings were created against the **local** seeded database by checks 9
  and 11 (`SR-1A0K4RY3EW`, `SR-0X3A3BYVR6`, seats A4 and A6 on show 1).
  `npm run seed` restores the demo dataset. Nothing touched Neon or production.
- `client/.env` was created locally for the build. It is gitignored and not part
  of the change.

### 22.8 Git state

`feat/seat-map`, created from `main` @ `692ffcf`. `main` untouched and still in
sync with `origin/main`. Nothing committed, nothing pushed, nothing merged.

---

## 23. Module 3.2 — Seat grid · implementation plan (approved)

**Approved:** 2026-08-20, with rulings recorded in §23.2.

### 23.1 Goal

Render the seat map for a show from `GET /api/shows/:id/seatmap` — rows in
layout order, aisles as gaps, tiers colour-coded, a legend, booked seats
visibly unavailable. Rendering only; no selection state.

### 23.2 Rulings taken before implementation

- **`client/src/App.jsx` in scope** — it is the only router, and Module 3.1's
  ruling (b) deferred the `/shows/:id` route here.
- **`client/src/pages/ShowsPage.jsx` in scope** — shows become links.
- **`client/src/money.js` NOT moved forward.** The module boundary in §6 stands:
  `money.js` remains Module 3.3's. The legend formats paise locally instead.
- **Append-only phase-doc changes approved** (§23, §24).

### 23.3 Approved file scope — 9 files

| File | Action |
|---|---|
| `client/src/seatmap/seatIndex.js` | new — pure, no React |
| `client/src/seatmap/SeatMap.jsx` | new |
| `client/src/seatmap/SeatButton.jsx` | new |
| `client/src/seatmap/Legend.jsx` | new |
| `client/src/seatmap/seatmap.css` | new |
| `client/src/pages/SeatMapPage.jsx` | new |
| `client/src/App.jsx` | modify — import + `/shows/:id` route |
| `client/src/pages/ShowsPage.jsx` | modify — shows become links |
| `docs/phases/phase-3-seat-map.md` | modify — append §23, §24 |

No dependencies. No server changes.

### 23.4 Design rules

- **`seats` decides what exists; `layout` decides where it goes.** A layout cell
  with no matching seat renders as a gap.
- **`data-seat-id` carries the API id.** Never an index, never `row+number` as
  identity.
- **`status` is an open string.** `isSelectable()` returns true only for
  `'available'`; `booked`, `held` and anything unrecognised render disabled.
- **No selection state, no click handler** — Module 3.3 supplies both as props.
- **No render optimisation.** No `React.memo`, no `useCallback` on seats, no
  virtualisation: Module 3.5 must measure the straightforward DOM version, or
  the canvas comparison in `BACKLOG.md` P1 is against a strawman. `useMemo`
  guards only the seat index, which is structural.
- **The map scrolls inside itself**; the page body never scrolls sideways.

---

## 24. Module 3.2 — close-out

**Status:** IMPLEMENTED and VERIFIED. Not committed at time of writing.
**Branch:** `feat/seat-map`, on top of `f51e75f`.
**Written:** 2026-08-20

### 24.1 What was implemented

The nine approved files, and nothing else. Six new (`seatIndex.js`,
`SeatMap.jsx`, `SeatButton.jsx`, `Legend.jsx`, `seatmap.css`,
`SeatMapPage.jsx`), two modified (`App.jsx`, `ShowsPage.jsx`), plus this
document.

`SeatMapPage` makes exactly one request — `GET /api/shows/:id/seatmap` — using
the existing `request()` helper. No server file, no `api/client.js` change, and
no new dependency.

### 24.2 Verification results

Local: WSL2 Ubuntu, Node v22.23.2, local Docker Postgres 17 + Redis, API on
:3000, **production build** served by `vite preview` on :4173, Chrome driven by
`javascript_tool`.

| # | Check | Result |
|---|---|---|
| 1 | Client production build | **PASS** — 34 modules, JS 236.90 kB (75.64 kB gzip), CSS 1.81 kB |
| 2 | `/shows/1` renders | **PASS** — 160 seats, 10 rows `A`–`J`, 16 per row |
| 3 | Aisles | **PASS** — 2 spacers per row, matching `aislesAfterColumn: [4,12]` |
| 4 | Booked seats | **PASS** — exactly `A1,A2,C5,C6,C7,I3,I4` disabled |
| 5 | Selectable count | **PASS** — 153 enabled |
| 6 | Legend | **PASS** — silver ₹200 · gold ₹320 · platinum ₹450 · unavailable |
| 7 | Unknown status (`held` injected into the payload) | **PASS** — renders `data-status="held"`, disabled, no crash |
| 8 | Seat absent from `seats[]` | **PASS** — 159 seats + exactly 1 `.seat--absent` gap |
| 9 | Seat identity | **PASS** — 160 unique `data-seat-id`, every one an API id (re-confirmed on screen 3) |
| 10 | No selection state | **PASS** — no `useState`/`useReducer`/`onClick` anywhere in `client/src/seatmap/` |
| 11 | Deep links | **PASS** — `/shows/1` → 200 and renders; `/shows/999999` → "Show not found", 0 seats, no crash |
| 12 | Second geometry (screen 3, IMAX) | **PASS** — 260 seats, 13 rows `A`–`M`, 20 per row, aisles at 5 and 15 |
| — | Page does not scroll sideways | **PASS** — `body.scrollWidth === body.clientWidth` on both screens |
| — | 3.1 → 3.2 integration | **PASS** — a show link on `/movies/1` navigates to `/shows/1` and renders 160 seats |

Checks 7 and 8 patched the **fetched payload in the browser only** — never the
source, never the database.

**NOT RUN:** Phase 2's contention suite — no server code changed.
**NOT MEASURED:** any performance figure. Module 3.5 owns measurement; nothing
in this module is a benchmark.

### 24.3 Deviations from the approved plan

1. **`seatIndex.js` returns `{ seatAt, tierPrices }`, not `{ …, counts }`.**
   `counts` was in the plan's signature but nothing consumed it, and shipping an
   unused field is dead code. Recorded rather than silently dropped.
2. **Price formatting lives inside `Legend.jsx`** as a local `rupees()`, per the
   ruling that `money.js` stays in Module 3.3. Module 3.3 extracts it; the
   comment in the file says so.

### 24.4 Notes carried to later modules

- `SeatButton` takes only `seat`. Module 3.3 adds `isSelected` and `onToggle`
  props; no other change to the render layer should be needed — that is the
  seam being tested.
- `isSelectable()` is the single place that decides selectability. Phase 4.3's
  `held` status already flows through it correctly, verified in check 7.
- The tier colour table in `seatmap.css` is keyed by `data-tier`. An unknown
  tier falls back to neutral rather than vanishing.

---

## 25. Module 3.3 — `useSeatSelection` · implementation plan (proposed)

**Status:** PROPOSED — not approved, not implemented.
**Branch:** `feat/seat-map`, on top of `1d5d712`.
**Written:** 2026-08-20

### 25.1 Objective

Put every piece of seat-selection state in one hook with no rendering in it, and
wire the existing render layer to it through props. The split is the deliverable:
`BACKLOG.md` P1's canvas renderer must be able to replace the drawing code
without touching selection logic.

### 25.2 User-visible outcome

On a show page a visitor can click an available seat to select it (highlighted),
click again to deselect, select up to **6**, and see a running count and total
that updates immediately. A 7th click is refused with a short message rather
than silently swapping a seat out. Booked seats remain unclickable. A "clear"
control empties the selection.

No booking happens — the proceed button and the price-breakdown panel are
Module 3.4.

### 25.3 Proposed file scope — 8 files

**New (2)**

| File | Responsibility |
|---|---|
| `client/src/seatmap/useSeatSelection.js` | All selection state and derivation. No JSX, no DOM, no fetch. |
| `client/src/money.js` | One function: integer paise to display string. |

**Modified (5)**

| File | Change |
|---|---|
| `client/src/pages/SeatMapPage.jsx` | Own the hook; pass `isSelected`/`onToggle` down; render the count/total line and clear control |
| `client/src/seatmap/SeatMap.jsx` | Accept `isSelected` / `onToggle` / `limitReached`, forward per seat |
| `client/src/seatmap/SeatButton.jsx` | Accept `selected` / `onToggle` / `limitReached`; add the click handler, `aria-pressed`, `data-selected` |
| `client/src/seatmap/seatmap.css` | Selected-seat styling; limit-reached affordance |
| `client/src/seatmap/Legend.jsx` | Replace the local `rupees()` with `money.js`, per §24.3 deviation 2 |

**Documentation (1):** `docs/phases/phase-3-seat-map.md` — this section, and §26
at close-out.

**Deviation from §6's 3.3 file table — three files it does not list.**
`SeatButton.jsx` and `seatmap.css` are unavoidable: a selection that cannot be
clicked or seen is not a selection, and §6 gave `SeatButton` no props beyond
`seat`. `Legend.jsx` changes only to consume `money.js`, so two formatters
cannot drift. Flagged rather than absorbed silently.

### 25.4 Interaction and state model

```
useSeatSelection({ seats, maxSeats = 6 })
  -> { selectedIds, isSelected(id), toggle(id), clear(),
       count, totalPaise, breakdown, limitReached }
```

- **State is one `Set` of seat ids (strings).** Never an index, never
  `row_label + seat_number` — those are presentation.
- **`toggle(id)`** resolves the id against the current seats and refuses, as a
  no-op, when: the seat is unknown, `isSelectable(status)` is false, or the seat
  is not already selected and `count === maxSeats`. **The 7th seat is refused;
  the oldest is never silently dropped.**
- **Pruning is derivation, not an effect.** Each render filters the stored set
  against the current `seats`, so an id that vanished or turned unavailable in a
  refetch stops counting immediately. The hook therefore contains **no
  `useEffect`** — no extra render pass, no flash of a stale total.
- **`limitReached`** is `count >= maxSeats`.
- **`clear()`** empties the set.

`MAX_SEATS_PER_BOOKING = 6` already exists and is enforced in
`server/src/lib/validate.js`. The client repeats it as UX only. The server
remains the enforcer — a limit only the browser applies is not a limit.

### 25.5 Data contracts consumed

No new endpoint, and **no request at all**. The hook consumes the `seats` array
already fetched by `SeatMapPage` from `GET /api/shows/:id/seatmap`:

`{ id, row_label, seat_number, tier, price_paise, status }`

`id` is a string, `price_paise` an integer, `status` an open string handled
through the existing `isSelectable()` in `seatIndex.js` — unchanged, so Phase
4.3's `held` keeps falling through as unselectable.

### 25.6 Authentication implications

**None.** Selection is entirely client-side: no API call, no token, no cookie,
no `requireAuth`. Selection is explicitly **not** gated behind login — an
anonymous visitor may browse and select. The login gate arrives in Module 3.4 at
the proceed step, exactly where `POST /api/bookings` requires it. Nothing here
touches `AuthContext`, `api/client.js`, or any server file.

### 25.7 Pricing and money

- `totalPaise` is an **integer sum** of `price_paise`. No floats, no rounding,
  no division anywhere in the hook.
- `breakdown` is `[{ tier, count, unitPaise, subtotalPaise }]`, grouped by tier
  in the order tiers first appear in `seats` — the API returns seats ordered by
  row then number, so that order is deterministic.
- **The single division happens in `money.js`**, at the moment a string is
  rendered. That is the whole reason the file exists.
- A `null` `price_paise` (possible via the `show_prices` LEFT JOIN) contributes
  **0** to the total and renders as an em dash per seat. Defensive only: the
  seed prices every tier its screen offers, and Phase 2 fails closed on a
  missing price. Recorded so the behaviour is a decision, not an accident.

### 25.8 Error, loading and empty states

- Loading and error handling in `SeatMapPage` are **unchanged** — 3.2 already
  covers the fetch, the 404 and the network failure.
- **Empty selection** renders "No seats selected", not blank space and not a
  zero total.
- **Limit reached** renders a short line, shown only once the ceiling is hit.
- **A sold-out show** needs no special case: every seat is disabled and the
  selection stays empty.
- **Seats pruned by a refetch** simply stop counting. Telling the user *which*
  seat they lost is conflict UX — Module 3.4's 409 path and `BACKLOG.md` P3.

### 25.9 Accessibility

- Seats stay native `<button>` elements: focusable, Enter/Space activated, no
  custom key handling.
- A selected seat carries **`aria-pressed`**, the correct semantics for a toggle
  button, alongside `data-selected` for styling.
- `aria-label` states seat, tier, status and selected state.
- When the limit is reached, unselected available seats get **`aria-disabled`
  rather than `disabled`** — they stay in the tab order and keep explaining
  themselves instead of vanishing from keyboard navigation.
- The count/total line is an **`aria-live="polite"`** region, so selecting a
  seat is announced rather than silently changing.
- Colour is never the only signal: selection is carried by `aria-pressed` and a
  border, not hue alone.
- Out of scope: canvas accessibility and a parallel keyboard navigation model
  (`BACKLOG.md` P3).

### 25.10 Verification

Production build served by `vite preview`, API on :3000, Chrome driven by
`javascript_tool`, clicking the real buttons so React's own handlers run.

| # | Check | Expected |
|---|---|---|
| 1 | `npm run build:client` | succeeds |
| 2 | Hook purity | no JSX, `document`, `window`, `fetch` or `useEffect` in `useSeatSelection.js` |
| 3 | Select | click A3 gives `aria-pressed="true"`, `data-selected="true"`, count 1 |
| 4 | Deselect | click A3 again gives count 0 |
| 5 | Booked seat | A1 stays `disabled`, never selectable |
| 6 | Ceiling | clicking 7 available seats leaves count at **6**, the 7th unselected, message shown |
| 7 | Oldest not dropped | the first of those 6 is still selected after the 7th click |
| 8 | Total | 3 silver + 1 gold = 92000 paise, displayed as the correct rupee string |
| 9 | Breakdown | groups by tier with correct counts and subtotals |
| 10 | Identity | selected `data-seat-id` values match the API ids exactly |
| 11 | Prune | patch the payload so a selected seat returns `booked`; it drops out and the total falls |
| 12 | Clear | clear control gives count 0 and no `aria-pressed="true"` remains |
| 13 | `money.js` | 20000, 32000, 45000 format correctly; null gives an em dash |
| 14 | Legend | still renders the same prices after migrating to `money.js` |
| 15 | Accessibility | live region present; disabled seats not focusable; at the limit, unselected seats are `aria-disabled` yet still focusable |

**Not run:** Phase 2's contention suite — no server change. **Not measured:**
any performance number. Module 3.5 owns measurement, and no memoisation is added
here for the reason recorded in §23.4.

### 25.11 Done-when

- `useSeatSelection.js` exists with the §25.4 signature and contains no
  rendering, no DOM access and no effects
- select, deselect, the 6-seat ceiling and the running total all work in a real
  browser
- selection is keyed by API seat id, and ids that vanish or become unavailable
  stop counting
- `totalPaise` is an integer; the only division lives in `money.js`
- `Legend` and the running total use the same formatter
- checks 1 to 15 pass

### 25.12 Dependencies

**None.** No new package, no server change, no schema change, no new endpoint.

### 25.13 Explicitly out of scope

| Excluded | Owner |
|---|---|
| `POST /api/bookings`, proceed button, booking result, 409 conflict UX | Module 3.4 |
| The summary panel itself — seat list and price-breakdown display | Module 3.4 |
| `npm run seed:stress`, the 5,000-seat layout, any measurement | Module 3.5 |
| Holds, TTL, countdown, `held` produced by the server | Phase 4 |
| WebSocket updates, rAF batching, optimistic selection | Phase 6 |
| Canvas renderer, quadtree, virtualisation, `React.memo`, `useCallback` on seats | `BACKLOG.md` P1 — 3.5 must measure the plain DOM version |
| Seat recommendation, group-seating rules | `BACKLOG.md` P2/P3 |
| Any server, migration, `loadtest/` or control-file change | not this module |
| A test framework | Q7 — not without separate approval |

---

## 26. Scope amendments approved during implementation

The module tables in §6 were written before the code existed. Where
implementation showed a table to be incomplete, the gap was reported and ruled
on individually rather than absorbed. This section is the record; §6 is left
exactly as approved.

| Module | File added to scope | Why it was unavoidable | Ruling |
|---|---|---|---|
| 3.2 | `client/src/App.jsx` | The only router in the app; §6's 3.2 table omitted it, but Module 3.1 ruling (b) had already deferred the `/shows/:id` route to 3.2 | Approved |
| 3.2 | `client/src/pages/ShowsPage.jsx` | Shows had to become links for the seat map to be reachable | Approved |
| 3.3 | `client/src/seatmap/SeatButton.jsx` | §6 gave it only a `seat` prop, but it is the clickable element — selection cannot be wired without it | Approved |
| 3.3 | `client/src/seatmap/seatmap.css` | A selection with no visual state fails §6.3's own done-when | Approved |
| 3.4 | `client/src/pages/LoginPage.jsx` | §6.4 requires that an unauthenticated visitor "returns to the same show" after login; `navigate('/')` was hard-coded | Approved |
| 3.5 | `client/vite.config.js` | See §26.1 | Approved |

Declined on purpose, to keep the expansions minimal:

- **`client/src/seatmap/Legend.jsx`** was proposed in §25.3 so both price
  formatters could be unified on `money.js`. The ruling kept `money.js` as
  Module 3.3's single new money file and left `Legend` alone. Two formatters
  therefore co-exist: `money.js` for the summary and totals, and a local
  `rupees()` inside `Legend.jsx`. Recorded as a known duplication, not an
  oversight.

### 26.1 `client/vite.config.js` — the profiling build

**Why it is required.** §12 (decision D8, question Q9) specifies that the
baseline is measured on a **production build with profiling enabled**. React's
production build strips the profiling hooks, so React DevTools cannot attach to
it and **"re-renders per seat click" cannot be measured at all**. The fallback
documented in §12.2 needs the same profiling-enabled build for that number, so
there is no path that avoids the change.

Building in development mode instead was rejected: StrictMode double-renders in
development, which would inflate the exact number being recorded.

**What changed.** Four lines, gated on an environment variable:

```js
const profiling = process.env.PROFILE === '1';
...(profiling
  ? { resolve: { alias: { 'react-dom/client': 'react-dom/profiling' } } }
  : {}),
```

- `npm run build:client` is **unaffected** — the deployed bundle never contains
  the profiling build.
- `PROFILE=1 npm run build:client` produces the measurement build, so the
  procedure in §12.3 is reproducible by anyone rather than depending on a local
  hack.
- **No new dependency:** `react-dom/profiling` is an entry point of the
  already-installed `react-dom` 19.2.8.
- **No application component was changed for measurement.** Instrumenting
  `SeatButton` with a render counter was considered and rejected — it would
  alter the component being measured.

---

## 27. Phase 3 — close-out

**Status:** IMPLEMENTED and VERIFIED. Not committed at time of writing.
**Branch:** `feat/seat-map`, on top of `727c38b`.
**Written:** 2026-08-21

Modules 3.1 and 3.2 and 3.3 were committed individually (`f51e75f`, `1d5d712`,
`727c38b`). Modules 3.4 and 3.5 were implemented back to back under a revised
workflow that batches verification to the end of the phase, so the results below
cover the phase as a whole rather than one module.

### 27.1 What exists at the end of Phase 3

A React client — served separately from the API, talking to it cross-origin —
that lists movies, lists a movie's shows, renders a seat map from the layout
JSON, selects up to six seats with a running total, and books them through the
Phase 2 endpoint. Sessions survive a refresh via an httpOnly cookie. A 5,000-seat
dataset and two recorded rendering numbers exist so the canvas rewrite in
`BACKLOG.md` P1 has a defensible "before".

### 27.2 Comprehensive verification

Environment: WSL2 Ubuntu, Node v22.23.2, local Docker Postgres 17 and Redis,
API on :3000, **production build** served by `vite preview` on :4173, Google
Chrome 151 driven programmatically.

**Build and scope**

| Check | Result |
|---|---|
| Normal production build | **PASS** — 241.74 kB (77.34 kB gzip), `index-DVXeHI2f.js` |
| `PROFILE=1` build | **PASS** — 258.49 kB, a distinct bundle |
| Profiling gate is inert for normal builds | **PASS** — the normal bundle hash is identical before and after `vite.config.js` changed |
| No dependency added in 3.4 or 3.5 | **PASS** — all four manifests unchanged except the `seed:stress` scripts |

**Module 3.1 — shell, CORS, auth (regression)**

| Check | Result |
|---|---|
| Cross-origin fetch from the client origin | **PASS** — 5 movies rendered |
| Session survives a full page load | **PASS** |
| Cookie unreadable from JavaScript | **PASS** — `document.cookie` never contains `sr_token` |
| Logout | **PASS** — header returns to "Log in", proceed reverts to "Log in to book" |

**Module 3.2 — seat grid (regression)**

| Check | Result |
|---|---|
| Show 1 geometry | **PASS** — 160 seats, 10 rows, 2 aisles per row |
| Booked seats unselectable | **PASS** — exactly `A1,A2,C5,C6,C7,I3,I4` |
| Legend | **PASS** — silver ₹200 · gold ₹320 · platinum ₹450 · unavailable |
| Navigation `/` → `/movies/:id` → `/shows/:id` | **PASS** |

**Module 3.3 — selection (regression)**

| Check | Result |
|---|---|
| Six-seat ceiling | **PASS** — 6 selected, `6 seats maximum.` shown |
| Seventh refused, oldest kept | **PASS** — count stays 6, first seat still `aria-pressed="true"`, seventh `aria-disabled="true"` and still focusable |
| Deselect and running total | **PASS** — 5 seats, ₹1,360, matching the hand-computed paise sum |

**Module 3.4 — booking**

| Check | Result |
|---|---|
| Logged-in booking, end to end | **PASS** — `SR-CSGD5RRPKG`, 5 seats, ₹1,360; seats then read `booked` |
| Booking result content | **PASS** — reference, seats, total, and the explicit "not paid yet — payment is Phase 5" note |
| Logged-out → login → same show | **PASS** — routed with `{from, seatIds}`, returned to `/shows/2` |
| Selection survives the login redirect | **PASS** — both seats restored, handoff state consumed |
| `409 SEATS_UNAVAILABLE` | **PASS** — a second client took a seat by `curl`; the message appeared, the map refreshed, the lost seat dropped itself from the selection, the other two were kept, nothing was booked |
| `401 UNAUTHENTICATED` | **PASS** — cookie cleared underneath the app; session dropped, routed to login carrying the seats, restored after re-login |
| `404 NOT_FOUND` | **PASS** — POST rewritten to a nonexistent show; client navigated to the movie page |

**Module 3.5 — dataset and measurement**

| Check | Result |
|---|---|
| `rowLabel()` indices 0–25 unchanged | **PASS** — 0 mismatches against the old implementation |
| Multi-letter labels | **PASS** — `Z → AA → AB`, `AZ → BA`, index 99 = `CV`, all `^[A-Z]+$`, all unique |
| Demo seed byte-identical after the change | **PASS** — seats fingerprint `89a62a21…` identical before and after re-seeding |
| `npm run seed:stress` | **PASS** — 100 rows × 50 = 5,000 seats, prints the show id |
| Additive, demo data untouched | **PASS** — demo fingerprint unchanged, 504 demo seats, bookings 5, booking_seats 11 |
| Re-runnable | **PASS** — second run reports "Replaced", still exactly 1 stress screen and 5,000 seats |
| 5,000 seats render | **PASS** — rows `A`…`CV`, 5,000 buttons |

**Measured baseline** — 10 trials, production build with profiling, Chrome 151:

| Metric | Result |
|---|---|
| `SeatButton` re-renders per click | **5,000 in every trial** |
| Click-to-paint | **median 79.0 ms**, range 33.2–113.4 ms |
| Commits per click | 1 |

Full method, including why the timing-based count (205–424) was rejected as a
severe undercount in favour of the props-reference comparison, is in `README.md`.

**Database side-effects**

| Check | Result |
|---|---|
| Double-booked seats across all verification | **0** |
| Verification bookings removed | **PASS** — `npm run seed` restored 5 bookings / 11 booking_seats / 504 seats, fingerprint `89a62a21…` |
| Neon / production | **Untouched.** No connection made, no query run |

### 27.2.1 Second-geometry reproduction — Module 3.4 navigation on show 3

The Module 3.4 navigation result in §27.2 was recorded against show 2. It was
challenged at close-out, so the flow was reproduced once against a **second
geometry** — show 3, `Audi 3 (IMAX)` — to confirm the behaviour is not specific
to one route. No implementation code was changed, and no performance
measurement was repeated.

Screen geometry, as verified in §24.2 check 12: **260 seats, 13 rows `A`–`M`,
20 seats per row, aisles after columns 5 and 15.**

| Step | URL | Router state |
|---|---|---|
| Start, logged out (header reads "Log in") | `/shows/3` | — |
| Selected `D5`, `D6` — `2 seats selected · ₹400` | `/shows/3` | — |
| Clicked "Log in to book" | `/login` | `{from: "/shows/3", seatIds: ["309","310"]}` |
| Submitted the real login form | **`/shows/3`** | consumed (`null`) |

| Check | Result |
|---|---|
| Final URL after login | **PASS** — `/shows/3`, matching `^/shows/\d+$`; full URL `http://localhost:4173/shows/3` |
| Selection survives the handoff | **PASS** — `D5`, `D6` restored by their API ids `309`, `310`, not by position |
| Summary after return | **PASS** — `2 seats selected · ₹400`, proceed enabled, header `demo@show-rush.dev` |
| Seat map re-rendered | **PASS** — 260 seats on the page, consistent with the geometry above |
| Direct `/login` default preserved | **PASS** — logging out, visiting `/login` with no router state and signing in lands on `/` |

This confirms the §27.2 result rather than correcting it: the recorded
behaviour was already `/shows/2`, and show 3 now provides the second data point.
The earlier record is left exactly as written.

### 27.3 Deviations

1. **`seatIndex.js` returns `{ seatAt, tierPrices }`, not `counts`** (§24.3).
2. **Price formatting is duplicated** — `money.js` for totals, a local `rupees()`
   in `Legend.jsx`. A deliberate ruling, recorded in §26.
3. **Six files were added to the module tables during implementation.** Each was
   reported and approved individually; the record is §26.
4. **Two defects were found by browser verification and fixed**: the `Intl`
   `dateStyle` + `timeZoneName` combination that threw at module load (§22.5),
   and a `ReferenceError` from a `seatIds` shorthand that referenced a variable
   destructured under a different name. Both blanked the page with a clean build
   and no console error. Neither would have been caught by HTTP-level checks.

### 27.4 Not verified, and not claimed

- **Production cookie behaviour** (`SameSite=None; Secure`, cross-site). The
  client is not deployed, so only the local same-site path has been exercised.
- **Deployment of the static site**, `render.yaml`, and `CLIENT_ORIGIN` in the
  Render dashboard — Q6 deferred all three to a separately authorized step.
- **Any performance claim beyond the two recorded numbers.** No throughput, no
  capacity, no comparison against another device or browser.
- Phase 2's contention suite was **not re-run**: no server code on the booking
  path changed in Phase 3.

### 27.5 Open items handed forward

- Deploy the client as a Render static site and verify the cross-site cookie
  (Q6, separately authorized).
- Fold `Legend.jsx` onto `money.js` when a module boundary no longer forbids it.
- The Phase 2 documentation mismatch reported in §18 is still unaddressed, by
  instruction.
- `BACKLOG.md` P1's canvas renderer now has its "before": 5,000 re-renders per
  click and a 79 ms median click-to-paint, both reproducible with
  `npm run seed:stress` and `PROFILE=1 npm run build:client`.
