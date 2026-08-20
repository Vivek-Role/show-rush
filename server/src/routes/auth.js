import { Router } from 'express';
import { clearAuthCookie, setAuthCookie } from '../lib/auth-cookie.js';
import { email, newPassword, personName, presentString } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { authenticate, issueToken, registerUser } from '../services/authService.js';

export const authRouter = Router();

// Both of these now set a cookie as well as returning the token. The JSON body
// is unchanged: API clients keep using the token, browsers use the cookie and
// ignore the token entirely, and neither transport knows about the other.
authRouter.post('/register', async (req, res) => {
  const body = req.body ?? {};

  const user = await registerUser({
    email: email(body.email),
    password: newPassword(body.password),
    name: personName(body.name),
  });

  const token = issueToken(user);
  setAuthCookie(res, token);

  res.status(201).json({ user, token });
});

authRouter.post('/login', async (req, res) => {
  const body = req.body ?? {};

  const user = await authenticate({
    email: email(body.email),
    password: presentString(body.password, 'password'),
  });

  const token = issueToken(user);
  setAuthCookie(res, token);

  res.json({ user, token });
});

// Deliberately unauthenticated: clearing a session that has already expired is
// a success, not a 401. Only the server can clear an httpOnly cookie, which is
// why this endpoint has to exist at all.
authRouter.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
