import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

export function LoginPage() {
  const { user, login, register } = useAuth();
  const navigate = useNavigate();

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
      navigate('/');
    } catch (err) {
      // The server's message is safe to show: it is written for humans and
      // says the same thing for an unknown email as for a wrong password.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (user) {
    return <p>Signed in as {user.email}.</p>;
  }

  return (
    <>
      <h1>{registering ? 'Create an account' : 'Log in'}</h1>

      <form onSubmit={onSubmit}>
        {registering && (
          <p>
            <label>
              Name{' '}
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
          </p>
        )}
        <p>
          <label>
            Email{' '}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
        </p>
        <p>
          <label>
            Password{' '}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
        </p>

        <button type="submit" disabled={busy}>
          {registering ? 'Register' : 'Log in'}
        </button>
      </form>

      {error && <p>{error}</p>}

      <p>
        <button type="button" onClick={() => setRegistering((value) => !value)}>
          {registering ? 'I already have an account' : 'Create an account instead'}
        </button>
      </p>
    </>
  );
}
