import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { MoviesPage } from './pages/MoviesPage.jsx';
import { ShowsPage } from './pages/ShowsPage.jsx';

export function App() {
  const { user, ready, logout } = useAuth();

  // Nothing renders until the session has been resolved once.
  if (!ready) return <p>Loading…</p>;

  return (
    <>
      <header>
        <Link to="/">show-rush</Link>{' '}
        {user ? (
          <>
            <span>{user.email}</span>{' '}
            <button type="button" onClick={logout}>
              Log out
            </button>
          </>
        ) : (
          <Link to="/login">Log in</Link>
        )}
      </header>

      <main>
        <Routes>
          <Route path="/" element={<MoviesPage />} />
          <Route path="/movies/:id" element={<ShowsPage />} />
          <Route path="/login" element={<LoginPage />} />
          {/* /shows/:id arrives with the seat map in Module 3.2. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}
