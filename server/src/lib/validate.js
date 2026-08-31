import { HttpError } from './http-error.js';

// Three endpoints do not justify a validation library. These are the checks
// those endpoints actually need, and nothing more.

export function validationError(message) {
  return new HttpError(400, 'VALIDATION_ERROR', message);
}

function asTrimmedString(value, field) {
  if (typeof value !== 'string') {
    throw validationError(`${field} must be a string`);
  }
  return value.trim();
}

// Deliberately permissive: one @, something either side, a dot in the domain.
// Rejecting a valid address is worse than accepting an odd one — the address
// is an identifier here, not a delivery target.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function email(value, field = 'email') {
  const trimmed = asTrimmedString(value, field).toLowerCase();
  if (trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed)) {
    throw validationError(`${field} must be a valid email address`);
  }
  return trimmed;
}

export function newPassword(value, field = 'password') {
  if (typeof value !== 'string') {
    throw validationError(`${field} must be a string`);
  }
  if (value.length < 8) {
    throw validationError(`${field} must be at least 8 characters`);
  }
  // bcrypt silently ignores everything past 72 bytes. Rejecting is honest;
  // accepting would mean a 200-character password is not what it appears.
  if (Buffer.byteLength(value) > 72) {
    throw validationError(`${field} must be at most 72 bytes`);
  }
  return value;
}

// Login checks the password against the stored hash, so length rules would
// only turn a wrong password into the wrong status code.
export function presentString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`${field} is required`);
  }
  return value;
}

// Module 2.1 / decision Q3. The Phase 3 seat-selection hook applies the same
// rule, but a limit only the browser enforces is not a limit.
export const MAX_SEATS_PER_BOOKING = 6;

// Ids arrive from JSON as either a string or a number. This checks only that
// the field is present and shaped like an identifier; whether it resolves to a
// row is the service's question, and an id that resolves to nothing is a 404 —
// the same answer the Phase 1 read routes give.
export function idValue(value, field) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  throw validationError(`${field} is required`);
}

export function seatIdList(value, field = 'seat_ids') {
  if (!Array.isArray(value)) {
    throw validationError(`${field} must be an array`);
  }
  if (value.length === 0) {
    throw validationError(`${field} must contain at least one seat`);
  }
  if (value.length > MAX_SEATS_PER_BOOKING) {
    throw validationError(`${field} must contain at most ${MAX_SEATS_PER_BOOKING} seats`);
  }

  const ids = value.map((entry, index) => idValue(entry, `${field}[${index}]`));

  // The same seat twice in one request is a client bug. Unchecked, it would
  // insert two booking_seats rows for one seat and charge for both.
  if (new Set(ids).size !== ids.length) {
    throw validationError(`${field} must not contain duplicate seats`);
  }

  return ids;
}

// Module 5.3. A booking reference is looked up verbatim — this only checks that
// something reference-shaped arrived, and an unknown one is a 404, the same
// answer every other read route gives.
export function bookingRef(value, field = 'booking_ref') {
  const trimmed = asTrimmedString(value, field);
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw validationError(`${field} is required`);
  }
  return trimmed;
}

// The provider's event id, and the key the whole idempotency layer turns on.
// Nothing is inferred from its shape: a real gateway picks the format, and
// rejecting an unfamiliar one would be this system deciding what another
// system's identifiers look like. Length is bounded because it is indexed.
export function eventId(value, field = 'payment_event_id') {
  const trimmed = asTrimmedString(value, field);
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw validationError(`${field} is required`);
  }
  return trimmed;
}

export function personName(value, field = 'name') {
  const trimmed = asTrimmedString(value, field);
  if (trimmed.length === 0) {
    throw validationError(`${field} is required`);
  }
  if (trimmed.length > 80) {
    throw validationError(`${field} must be at most 80 characters`);
  }
  return trimmed;
}
