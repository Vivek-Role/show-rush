import { pool } from '../db/pool.js';

// Route parameters arrive as strings and the keys are bigint, so anything
// non-numeric — or numeric but past the range bigint can hold — would make
// Postgres raise on the cast instead of simply not matching. Both are treated
// as "no such row", the same as an id that does not exist.
const MAX_BIGINT = 9223372036854775807n;

export function isId(value) {
  const text = String(value);
  return /^\d+$/.test(text) && BigInt(text) <= MAX_BIGINT;
}

function publicMovie(row) {
  return {
    id: String(row.id),
    title: row.title,
    description: row.description,
    duration_minutes: row.duration_minutes,
    language: row.language,
    certificate: row.certificate,
    poster_url: row.poster_url,
  };
}

export async function listMovies() {
  const { rows } = await pool.query(
    `select id, title, description, duration_minutes, language, certificate, poster_url
     from movies
     order by title`,
  );
  return rows.map(publicMovie);
}

export async function getMovie(movieId) {
  if (!isId(movieId)) return null;

  const { rows } = await pool.query(
    `select id, title, description, duration_minutes, language, certificate, poster_url
     from movies
     where id = $1`,
    [movieId],
  );
  return rows[0] ? publicMovie(rows[0]) : null;
}

export async function listShowsForMovie(movieId) {
  if (!isId(movieId)) return [];

  const { rows } = await pool.query(
    `select sh.id, sh.starts_at, sc.id as screen_id, sc.name as screen_name
     from shows sh
     join screens sc on sc.id = sh.screen_id
     where sh.movie_id = $1
     order by sh.starts_at, sc.name`,
    [movieId],
  );

  return rows.map((row) => ({
    id: String(row.id),
    starts_at: row.starts_at,
    screen: { id: String(row.screen_id), name: row.screen_name },
  }));
}

// The show together with the screen it runs on. The layout travels with the
// screen because it is presentation data — which seats exist is answered by
// availabilityService reading the seats table, never by this JSON.
export async function getShowWithScreen(showId) {
  if (!isId(showId)) return null;

  const { rows } = await pool.query(
    `select
       sh.id, sh.starts_at,
       m.id as movie_id, m.title as movie_title, m.duration_minutes, m.language, m.certificate,
       sc.id as screen_id, sc.name as screen_name, sc.cinema_name, sc.layout
     from shows sh
     join movies m on m.id = sh.movie_id
     join screens sc on sc.id = sh.screen_id
     where sh.id = $1`,
    [showId],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    show: {
      id: String(row.id),
      starts_at: row.starts_at,
      movie: {
        id: String(row.movie_id),
        title: row.movie_title,
        duration_minutes: row.duration_minutes,
        language: row.language,
        certificate: row.certificate,
      },
    },
    screen: {
      id: String(row.screen_id),
      name: row.screen_name,
      cinema_name: row.cinema_name,
      layout: row.layout,
    },
  };
}

// Do these seat ids belong to that screen? A catalogue question, and the same
// answer bookingService.resolveSeats takes from the seats table — seat identity
// lives in Postgres, never in Redis, so holdService is not asked to know it.
// Returns the ids that exist; the caller compares counts and decides the status
// code, exactly as the booking path does.
export async function seatIdsOnScreen(screenId, seatIds) {
  // A malformed id would make Postgres raise on the bigint cast rather than
  // simply not matching. Treated as "no such seat", like everywhere else.
  if (!isId(screenId) || !seatIds.every(isId)) return [];

  const { rows } = await pool.query(
    `select id from seats where screen_id = $1 and id = any($2::bigint[])`,
    [screenId, seatIds],
  );

  return rows.map((row) => String(row.id));
}
