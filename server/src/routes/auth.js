import { Router } from 'express';
import { email, newPassword, personName, presentString } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { authenticate, issueToken, registerUser } from '../services/authService.js';

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const body = req.body ?? {};

  const user = await registerUser({
    email: email(body.email),
    password: newPassword(body.password),
    name: personName(body.name),
  });

  res.status(201).json({ user, token: issueToken(user) });
});

authRouter.post('/login', async (req, res) => {
  const body = req.body ?? {};

  const user = await authenticate({
    email: email(body.email),
    password: presentString(body.password, 'password'),
  });

  res.json({ user, token: issueToken(user) });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
