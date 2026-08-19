import { HttpError } from '../lib/http-error.js';
import { findUserById, verifyToken } from '../services/authService.js';

function unauthenticated() {
  return new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
}

// Express 5 forwards rejected async middleware to the error handler, so this
// needs no try/catch wrapper.
export async function requireAuth(req, res, next) {
  const [scheme, token] = (req.get('authorization') ?? '').split(' ');

  if (scheme !== 'Bearer' || !token) {
    throw unauthenticated();
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
