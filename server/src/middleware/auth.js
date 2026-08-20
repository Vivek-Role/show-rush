import { AUTH_COOKIE } from '../lib/auth-cookie.js';
import { HttpError } from '../lib/http-error.js';
import { findUserById, verifyToken } from '../services/authService.js';

function unauthenticated() {
  return new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
}

// Methods that do not change state. A cookie riding along on one of these is
// harmless, so the CSRF rule below guards writes only.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// A browser attaches cookies to a cross-site POST by itself. It cannot attach
// a custom header without a preflight the attacker's origin fails, so this
// header is the proof that a cookie-authenticated write came from our client.
const CSRF_HEADER_VALUE = 'show-rush';

// Express 5 forwards rejected async middleware to the error handler, so this
// needs no try/catch wrapper.
export async function requireAuth(req, res, next) {
  const [scheme, bearer] = (req.get('authorization') ?? '').split(' ');

  // Bearer first, and deliberately exempt from the CSRF rule below: an
  // Authorization header cannot be attached to a cross-site request by a form
  // post, so it carries its own proof of intent. This precedence is also what
  // keeps the k6 load test and every documented curl example working
  // byte-for-byte unchanged.
  let token = scheme === 'Bearer' && bearer ? bearer : null;
  let viaCookie = false;

  if (!token && req.cookies?.[AUTH_COOKIE]) {
    token = req.cookies[AUTH_COOKIE];
    viaCookie = true;
  }

  if (!token) {
    throw unauthenticated();
  }

  if (
    viaCookie &&
    !SAFE_METHODS.has(req.method) &&
    req.get('x-requested-with') !== CSRF_HEADER_VALUE
  ) {
    throw new HttpError(
      403,
      'CSRF_HEADER_REQUIRED',
      `Cookie-authenticated requests must send X-Requested-With: ${CSRF_HEADER_VALUE}`,
    );
  }

  const payload = verifyToken(token);
  const user = await findUserById(payload.sub);

  // A valid signature over a user that no longer exists is not a session.
  if (!user) {
    throw unauthenticated();
  }

  req.user = user;
  next();
}
