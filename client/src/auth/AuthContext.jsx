import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { request } from '../api/client.js';

// Plain context, no state library. The whole session model is "who is logged
// in", and the token itself is an httpOnly cookie this code cannot read.
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);

  // False until the cookie has been checked once. Rendering before that would
  // flash a logged-out header at a user who is in fact logged in, and would
  // bounce them to /login on a refresh.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // This is what makes a refresh survivable: the cookie is sent, the server
    // says who it belongs to, and the session is restored. Nothing is read
    // from localStorage, because nothing is ever written there.
    request('/api/auth/me')
      .then((data) => {
        if (!cancelled) setUser(data.user);
      })
      .catch(() => {
        // 401 is the ordinary "not logged in" answer, not an error to show.
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await request('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    // The response still carries a token for API clients. The browser ignores
    // it on purpose — the cookie the server set is the session here.
    setUser(data.user);
  }, []);

  const register = useCallback(async (email, password, name) => {
    const data = await request('/api/auth/register', {
      method: 'POST',
      body: { email, password, name },
    });
    setUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    // Only the server can clear an httpOnly cookie, so the local state is
    // cleared regardless of what the call does.
    await request('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, ready, login, register, logout }),
    [user, ready, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }
  return value;
}
