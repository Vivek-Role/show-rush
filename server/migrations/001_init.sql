-- Phase 1.2 — the whole schema, in one migration.
--
-- bookings.status and bookings.booking_ref are defined here but read by
-- nothing until Phase 5. PLAN.md asks for one migration rather than three.
--
-- All ids are bigint identity. All timestamps are timestamptz. All money is
-- integer paise — never a float.

create table users (
  id            bigint generated always as identity primary key,
  email         text        not null unique,
  password_hash text        not null,
  name          text        not null,
  created_at    timestamptz not null default now()
);

create table movies (
  id               bigint generated always as identity primary key,
  title            text        not null,
  description      text        not null default '',
  duration_minutes integer     not null check (duration_minutes > 0),
  language         text        not null,
  certificate      text        not null,
  poster_url       text,
  created_at       timestamptz not null default now()
);

-- One cinema in this build, so it is a column rather than a table.
-- Multi-cinema is BACKLOG.md P4, deliberately cut.
--
-- layout is presentation only — rows, columns, tiers, aisles. It never decides
-- which seats exist: the seats table does, and every foreign key points there.
create table screens (
  id          bigint generated always as identity primary key,
  cinema_name text        not null,
  name        text        not null,
  layout      jsonb       not null,
  created_at  timestamptz not null default now()
);

-- Authoritative for seat identity.
create table seats (
  id          bigint generated always as identity primary key,
  screen_id   bigint      not null references screens (id) on delete cascade,
  row_label   text        not null,
  seat_number integer     not null check (seat_number > 0),
  tier        text        not null,
  created_at  timestamptz not null default now(),
  unique (screen_id, row_label, seat_number)
);

create table shows (
  id         bigint generated always as identity primary key,
  movie_id   bigint      not null references movies (id) on delete cascade,
  screen_id  bigint      not null references screens (id) on delete cascade,
  starts_at  timestamptz not null,
  created_at timestamptz not null default now()
);

-- Price per tier per show, joined into the seat map so the price arrives with
-- the seat in one round trip.
create table show_prices (
  show_id     bigint  not null references shows (id) on delete cascade,
  tier        text    not null,
  price_paise integer not null check (price_paise > 0),
  primary key (show_id, tier)
);

-- status and booking_ref are defined now and read by nothing until Phase 5.
-- booking_ref is the public identifier: the API and the payment flow use it,
-- never the integer id.
create table bookings (
  id          bigint generated always as identity primary key,
  booking_ref text        not null unique,
  user_id     bigint      not null references users (id),
  show_id     bigint      not null references shows (id),
  status      text        not null default 'pending'
              check (status in ('pending', 'paid', 'cancelled', 'refund_pending')),
  total_paise integer     not null default 0 check (total_paise >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- show_id is carried here as well as on bookings because Phase 2.4's
-- constraint is UNIQUE (show_id, seat_id) and must be enforceable on this
-- table alone.
--
-- There is deliberately NO unique constraint on (show_id, seat_id). Phase 2.1
-- needs the double-booking race to be reproducible, and Phase 2.4 adds the
-- constraint as its fix. Adding it here destroys the before/after measurement
-- PLAN.md lists as non-negotiable. Do not "fix" this.
create table booking_seats (
  id         bigint generated always as identity primary key,
  booking_id bigint      not null references bookings (id) on delete cascade,
  show_id    bigint      not null references shows (id),
  seat_id    bigint      not null references seats (id),
  created_at timestamptz not null default now()
);

-- Foreign-key hygiene only. Index tuning is Phase 7.3b and needs approval.
create index seats_screen_id_idx on seats (screen_id);
create index shows_movie_id_idx on shows (movie_id);
create index shows_screen_id_starts_at_idx on shows (screen_id, starts_at);
create index bookings_user_id_idx on bookings (user_id);
create index bookings_show_id_idx on bookings (show_id);
create index booking_seats_booking_id_idx on booking_seats (booking_id);

-- Non-unique on purpose: it supports the availability query and does nothing
-- to prevent the Phase 2.1 race.
create index booking_seats_show_id_seat_id_idx on booking_seats (show_id, seat_id);
