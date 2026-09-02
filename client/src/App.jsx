import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.jsx';
import { CityPicker } from './city/CityPicker.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { MoviesPage } from './pages/MoviesPage.jsx';
import { SeatMapPage } from './pages/SeatMapPage.jsx';
import { ShowsPage } from './pages/ShowsPage.jsx';

export function App() {
  const { user, ready, logout } = useAuth();

  // Nothing renders until the session has been resolved once. Shown as the same
  // shell the app uses, so the header does not appear a moment later and shove
  // the page down.
  if (!ready) {
    return (
      <>
        <Header />
        <main className="app-main" id="main">
          <p className="empty">Loading…</p>
        </main>
      </>
    );
  }

  return (
    <>
      {/* First stop for a keyboard, so the whole header does not have to be
          tabbed through on every page. Visible only when focused. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <Header user={user} onLogout={logout} />

      {/* tabIndex -1 so it can be focused by the skip link without ever
          becoming a tab stop of its own. */}
      <main className="app-main" id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<MoviesPage />} />
          <Route path="/movies/:id" element={<ShowsPage />} />
          <Route path="/shows/:id" element={<SeatMapPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <footer className="app-footer">
        Seats are held for seven minutes while you check out.
      </footer>
    </>
  );
}

function Header({ user, onLogout }) {
  return (
    <header className="app-header">
      <div className="app-header__inner">
        <Link className="brand" to="/">
          <span className="brand__mark" aria-hidden="true">
            ▶
          </span>
          Show-Rush
        </Link>

        <span className="app-header__spacer" />

        {/* Location first, the way every booking site orders its header: the
            city decides which venues the rest of the app is talking about. */}
        <CityPicker />

        {user ? (
          <>
            <span className="app-header__user" title={user.email}>
              {user.email}
            </span>
            <button type="button" className="btn btn--onDark btn--sm" onClick={onLogout}>
              Log out
            </button>
          </>
        ) : (
          <Link className="btn btn--onDark btn--sm" to="/login">
            Log in
          </Link>
        )}
      </div>
    </header>
  );
}
