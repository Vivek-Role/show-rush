import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

export function LoginPage() {
  const { user, login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Set when a page sent the visitor here mid-task — the seat map does, so it
  // can get them back to the show they were booking, with their seats. A direct
  // visit to /login carries no state and still lands on the movie list.
  const returnTo = location.state?.from ?? '/';
  const seatIds = location.state?.seatIds;

  const [registering, setRegistering] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      if (registering) {
        await register(email, password, name);
      } else {
        await login(email, password);
      }
      // replace, so Back does not return to a login form the visitor has
      // already completed.
      navigate(returnTo, { replace: true, state: seatIds ? { seatIds } : null });
    } catch (err) {
      // The server's message is safe to show: it is written for humans and
      // says the same thing for an unknown email as for a wrong password.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (user) {
    return (
      <div className="auth card">
        <div className="card__body stack">
          <p>
            Signed in as <strong>{user.email}</strong>.
          </p>
          <Link className="btn btn--primary btn--block" to="/">
            Browse films
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <div className="card">
        <div className="card__body">
          <h1>{registering ? 'Create an account' : 'Welcome back'}</h1>
          <p className="page-head__sub" style={{ marginTop: '0.35rem', marginBottom: '1rem' }}>
            {seatIds?.length
              ? 'Sign in to hold the seats you picked.'
              : 'Sign in to book seats.'}
          </p>

          <form onSubmit={onSubmit} noValidate={false}>
            {registering && (
              <label className="field">
                <span className="field__label">Name</span>
                <input
                  className="field__input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  required
                />
              </label>
            )}

            <label className="field">
              <span className="field__label">Email</span>
              <input
                className="field__input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </label>

            <label className="field">
              <span className="field__label">Password</span>
              <input
                className="field__input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={registering ? 'new-password' : 'current-password'}
                required
              />
            </label>

            {error ? (
              <p className="note note--error" role="alert" style={{ marginBottom: '0.85rem' }}>
                {error}
              </p>
            ) : null}

            <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
              {busy ? 'Signing in…' : registering ? 'Create account' : 'Log in'}
            </button>
          </form>

          <p className="auth__switch">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setRegistering((value) => !value)}
            >
              {registering ? 'I already have an account' : 'Create an account instead'}
            </button>
          </p>
        </div>
      </div>

      {/* The demo account is published in the README; repeating it here saves
          anyone trying the app from digging for it. */}
      {registering ? null : (
        <p className="note note--info auth__demo">
          <span>
            Demo account: <code>demo@show-rush.dev</code> / <code>demo-password</code>
          </span>
        </p>
      )}
    </div>
  );
}
