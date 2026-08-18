import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { assertAuthConfig, config } from '../config/env.js';
import { pool } from '../db/pool.js';
import { HttpError } from '../lib/http-error.js';

// Importing this module is what makes the server refuse to start without a
// signing secret. The migration runner never imports it, so migrations keep
// working without one.
assertAuthConfig();

const BCRYPT_ROUNDS = 10;

// Compared against when the email is unknown, so a login attempt costs the
// same either way and response timing does not reveal which emails exist.
const ABSENT_USER_HASH = bcrypt.hashSync('no-such-user', BCRYPT_ROUNDS);

// The only shape a user is exposed in. password_hash is not part of it, and
// nothing outside this module selects that column for output.
function publicUser(row) {
  return { id: String(row.id), email: row.email, name: row.name };
}

export function issueToken(user) {
  return jwt.sign({}, config.jwtSecret, {
    subject: String(user.id),
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
  });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    // Expired, tampered, wrong algorithm, malformed — all the same to a caller.
    throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired token');
  }
}

export async function registerUser({ email, password, name }) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    // The unique index decides, not a prior SELECT — a check-then-insert would
    // be racy for exactly the reason Phase 2 exists to demonstrate.
    const { rows } = await pool.query(
      `insert into users (email, password_hash, name)
       values ($1, $2, $3)
       returning id, email, name`,
      [email, passwordHash, name],
    );
    return publicUser(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      throw new HttpError(409, 'EMAIL_TAKEN', 'That email address is already registered');
    }
    throw err;
  }
}

export async function authenticate({ email, password }) {
  const { rows } = await pool.query(
    'select id, email, name, password_hash from users where email = $1',
    [email],
  );
  const row = rows[0];

  const matches = await bcrypt.compare(password, row?.password_hash ?? ABSENT_USER_HASH);

  // One message for both cases: an unknown email and a wrong password are
  // indistinguishable, so the endpoint cannot be used to enumerate accounts.
  if (!row || !matches) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
  }

  return publicUser(row);
}

export async function findUserById(id) {
  // sub comes from a token payload; anything non-numeric would make Postgres
  // raise on the bigint cast rather than simply not matching.
  if (typeof id !== 'string' || !/^\d+$/.test(id)) return null;

  const { rows } = await pool.query(
    'select id, email, name from users where id = $1',
    [id],
  );
  return rows[0] ? publicUser(rows[0]) : null;
}
