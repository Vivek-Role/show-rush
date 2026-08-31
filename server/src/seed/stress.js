import { config } from '../config/env.js';
import { closePool, pool } from '../db/pool.js';
import { STRESS_SCREEN, STRESS_SHOW, TIER_PRICES, showStartsAt } from './data.js';
import { countSeatsInLayout, generateScreenLayout } from './layout.js';

// Module 3.5 — the 5,000-seat dataset behind the frontend baseline numbers.
//
// Unlike seed/index.js this NEVER truncates. The demo dataset has to survive:
// it is what the deployed demo shows, and re-creating it just to measure a
// render would make the measurement expensive to repeat.
//
// Re-runnable instead by removing only what a previous stress run created,
// matched on the screen's literal name. Nothing outside that screen is ever in
// scope, which is what makes a destructive statement safe here.
async function clearPreviousRun(client) {
  const { rows } = await client.query('select id from screens where name = $1', [
    STRESS_SCREEN.name,
  ]);

  const screen = rows[0];
  if (!screen) return false;

  // Order matters: booking_seats cascades from bookings, show_prices cascades
  // from shows, and seats cascade from the screen. Deleting shows before their
  // bookings would trip the booking_seats foreign key.
  await client.query(
    'delete from bookings where show_id in (select id from shows where screen_id = $1)',
    [screen.id],
  );
  await client.query('delete from shows where screen_id = $1', [screen.id]);
  await client.query('delete from screens where id = $1', [screen.id]);

  return true;
}

async function seedStress(client) {
  const replaced = await clearPreviousRun(client);

  // An existing movie rather than a new one: this script adds a screen and a
  // show, not a catalogue. Ordered by title so the choice is deterministic.
  const { rows: movieRows } = await client.query('select id, title from movies order by title limit 1');
  const movie = movieRows[0];

  if (!movie) {
    throw new Error('No movies found. Run "npm run seed" first — this script adds to that dataset.');
  }

  const { layout, seats } = generateScreenLayout(STRESS_SCREEN);

  // The layout's own count is derived from the presentation structure, the seat
  // list from the same pass. Comparing them catches a generator that has
  // drifted rather than trusting either number.
  if (countSeatsInLayout(layout) !== seats.length) {
    throw new Error(`Layout describes ${countSeatsInLayout(layout)} seats but ${seats.length} were generated`);
  }

  const { rows: screenRows } = await client.query(
    'insert into screens (cinema_name, name, layout) values ($1, $2, $3) returning id',
    ['Rush Cinemas, Bengaluru', STRESS_SCREEN.name, layout],
  );
  const screenId = screenRows[0].id;

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

  const { rows: showRows } = await client.query(
    'insert into shows (movie_id, screen_id, starts_at) values ($1, $2, $3) returning id',
    [movie.id, screenId, showStartsAt(STRESS_SHOW.dayOffset, STRESS_SHOW.time)],
  );
  const showId = showRows[0].id;

  const tiers = STRESS_SCREEN.tierBands.map((band) => band.tier);
  await client.query(
    `insert into show_prices (show_id, tier, price_paise)
     select $1, * from unnest($2::text[], $3::int[])`,
    [showId, tiers, tiers.map((tier) => TIER_PRICES[tier])],
  );

  return {
    replaced,
    movie: movie.title,
    screenId: String(screenId),
    showId: String(showId),
    rows: layout.rows.length,
    seatsPerRow: layout.seatsPerRow,
    seats: seats.length,
  };
}

async function main() {
  // The same refusal seed/index.js makes. This script deletes rows, and doing
  // that against the deployed database is never part of a measurement.
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
    // One transaction: a failure anywhere leaves the database exactly as it
    // was, never holding half a stadium.
    await client.query('begin');
    const result = await seedStress(client);
    await client.query('commit');

    console.log(`${result.replaced ? 'Replaced' : 'Created'} screen "${STRESS_SCREEN.name}"`);
    console.log(`  rows           ${result.rows}`);
    console.log(`  seats per row  ${result.seatsPerRow}`);
    console.log(`  seats          ${result.seats}`);
    console.log(`  movie          ${result.movie}`);
    // The measurement procedure quotes this id, so print it rather than making
    // anyone go looking for it.
    console.log(`  show id        ${result.showId}`);
    console.log(`\nseat map: /shows/${result.showId}`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    console.error('Stress seed failed, rolled back:', err.message);
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
