import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';
import { closePool, pool } from '../db/pool.js';
import {
  CINEMA_NAME,
  DEMO_USER,
  MOVIES,
  PREBOOKED_BOOKINGS,
  SCREENS,
  SHOW_SCHEDULE,
  TIER_PRICES,
  showStartsAt,
} from './data.js';
import { generateScreenLayout } from './layout.js';

// Matches authService. Importing that module instead would drag in its
// JWT_SECRET assertion, and seeding has no business needing a signing secret.
const BCRYPT_ROUNDS = 10;

// TRUNCATE first, so the seed is re-runnable rather than additive. That makes
// it destructive by definition, which is fine locally and never fine against
// the deployed database.
const RESET = `
  truncate booking_seats, bookings, show_prices, shows, seats, screens, movies, users
  restart identity cascade
`;

function parseSeatSpec(spec) {
  const match = /^([A-Z]+)(\d+)$/.exec(spec);
  if (!match) throw new Error(`Malformed seat reference: ${spec}`);
  return { rowLabel: match[1], seatNumber: Number(match[2]) };
}

async function seed(client) {
  await client.query(RESET);

  const passwordHash = await bcrypt.hash(DEMO_USER.password, BCRYPT_ROUNDS);
  const { rows: userRows } = await client.query(
    'insert into users (email, password_hash, name) values ($1, $2, $3) returning id',
    [DEMO_USER.email, passwordHash, DEMO_USER.name],
  );
  const demoUserId = userRows[0].id;

  const movieIds = [];
  for (const movie of MOVIES) {
    const { rows } = await client.query(
      `insert into movies (title, description, duration_minutes, language, certificate, poster_url)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        movie.title,
        movie.description,
        movie.durationMinutes,
        movie.language,
        movie.certificate,
        movie.posterUrl,
      ],
    );
    movieIds.push(rows[0].id);
  }

  const screenIds = [];
  let seatCount = 0;

  for (const screen of SCREENS) {
    // One call produces both the layout and the seat rows.
    const { layout, seats } = generateScreenLayout(screen);

    const { rows } = await client.query(
      'insert into screens (cinema_name, name, layout) values ($1, $2, $3) returning id',
      [CINEMA_NAME, screen.name, layout],
    );
    const screenId = rows[0].id;
    screenIds.push(screenId);

    await client.query(
      `insert into seats (screen_id, row_label, seat_number, tier)
       select $1, * from unnest($2::text[], $3::int[], $4::text[])`,
      [
        screenId,
        seats.map((seat) => seat.rowLabel),
        seats.map((seat) => seat.seatNumber),
        seats.map((seat) => seat.tier),
      ],
    );
    seatCount += seats.length;
  }

  const showIds = [];
  for (const entry of SHOW_SCHEDULE) {
    const { rows } = await client.query(
      'insert into shows (movie_id, screen_id, starts_at) values ($1, $2, $3) returning id',
      [
        movieIds[entry.movieIndex],
        screenIds[entry.screenIndex],
        showStartsAt(entry.dayOffset, entry.time),
      ],
    );
    const showId = rows[0].id;
    showIds.push(showId);

    // Every tier the screen offers gets a price for this show.
    const tiers = SCREENS[entry.screenIndex].tierBands.map((band) => band.tier);
    await client.query(
      `insert into show_prices (show_id, tier, price_paise)
       select $1, * from unnest($2::text[], $3::int[])`,
      [showId, tiers, tiers.map((tier) => TIER_PRICES[tier])],
    );
  }

  let bookedSeatCount = 0;

  for (const booking of PREBOOKED_BOOKINGS) {
    const showId = showIds[booking.showIndex];
    const screenId = screenIds[SHOW_SCHEDULE[booking.showIndex].screenIndex];

    const specs = booking.seats.map(parseSeatSpec);
    const { rows: seatRows } = await client.query(
      `select s.id, s.tier
       from seats s
       join unnest($2::text[], $3::int[]) as wanted(row_label, seat_number)
         on wanted.row_label = s.row_label and wanted.seat_number = s.seat_number
       where s.screen_id = $1`,
      [screenId, specs.map((s) => s.rowLabel), specs.map((s) => s.seatNumber)],
    );

    // A seat reference that does not resolve is a bug in data.js, not a seat
    // that happens to be missing. Fail rather than book fewer seats than asked.
    if (seatRows.length !== specs.length) {
      throw new Error(
        `Booking ${booking.ref}: resolved ${seatRows.length} of ${specs.length} seats`,
      );
    }

    const totalPaise = seatRows.reduce((sum, seat) => sum + TIER_PRICES[seat.tier], 0);

    const { rows: bookingRows } = await client.query(
      `insert into bookings (booking_ref, user_id, show_id, status, total_paise)
       values ($1, $2, $3, 'paid', $4) returning id`,
      [booking.ref, demoUserId, showId, totalPaise],
    );
    const bookingId = bookingRows[0].id;

    await client.query(
      `insert into booking_seats (booking_id, show_id, seat_id)
       select $1, $2, * from unnest($3::bigint[])`,
      [bookingId, showId, seatRows.map((seat) => seat.id)],
    );
    bookedSeatCount += seatRows.length;
  }

  return {
    users: 1,
    movies: movieIds.length,
    screens: screenIds.length,
    seats: seatCount,
    shows: showIds.length,
    bookings: PREBOOKED_BOOKINGS.length,
    bookedSeats: bookedSeatCount,
  };
}

async function main() {
  // The seed truncates. Against the deployed database that would delete real
  // data, so refuse by default and make the override explicit.
  if (config.nodeEnv === 'production' && !process.argv.includes('--force')) {
    console.error('Refusing to seed with NODE_ENV=production. Pass --force to override.');
    process.exitCode = 1;
    return;
  }

  if (!pool) {
    console.error('DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  const client = await pool.connect();

  try {
    // One transaction for the whole seed: a failure anywhere leaves the
    // database exactly as it was, never half-seeded.
    await client.query('begin');
    const counts = await seed(client);
    await client.query('commit');

    for (const [label, count] of Object.entries(counts)) {
      console.log(`${String(count).padStart(5)}  ${label}`);
    }
    console.log(`\ndemo login: ${DEMO_USER.email} / ${DEMO_USER.password}`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    console.error('Seed failed, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

try {
  await main();
} finally {
  await closePool();
}
