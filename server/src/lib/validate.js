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
