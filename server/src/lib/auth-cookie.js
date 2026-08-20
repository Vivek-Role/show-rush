import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

// The single definition of the session cookie. routes/auth.js sets and clears
// it, middleware/auth.js reads it, and neither repeats the literals — a cookie
// cleared with attributes that do not match how it was set is not cleared at
// all, and that failure is silent.
export const AUTH_COOKIE = 'sr_token';

// In production the client is a separate Render static site, so the cookie
// travels cross-site: onrender.com is on the Public Suffix List, which makes
// the two subdomains different sites. That requires SameSite=None, which in
// turn requires Secure. Locally both run on localhost — same site, different
// ports — so Lax is enough, and Secure would stop the cookie working at all
// over plain http.
function cookieOptions(maxAge) {
  const production = config.nodeEnv === 'production';

  return {
    // Never readable by JavaScript, so an XSS cannot walk off with the session.
    httpOnly: true,
    secure: production,
    sameSite: production ? 'none' : 'lax',
    path: '/',
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

// The cookie expires with the token it carries. Reading `exp` off the token
// avoids a second lifetime constant that could drift from JWT_EXPIRES_IN, and
// avoids parsing durations like '7d' by hand.
function maxAgeFor(token) {
  const exp = jwt.decode(token)?.exp;
  if (!exp) return undefined;
  return Math.max(0, exp * 1000 - Date.now());
}

export function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, cookieOptions(maxAgeFor(token)));
}

export function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE, cookieOptions());
}
