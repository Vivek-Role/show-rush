import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from '../api/client.js';
import { Poster } from '../Poster.jsx';

export function MoviesPage() {
  const [movies, setMovies] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    document.title = 'Now showing · Show-Rush';
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    request('/api/movies')
      .then((data) => {
        if (!cancelled) setMovies(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Now showing</h1>
        {movies ? (
          <p className="page-head__sub">
            {movies.length} {movies.length === 1 ? 'film' : 'films'}
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="note note--error" role="alert">
          <span>{error}</span>
          <span className="note__spacer" />
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setMovies(null);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </p>
      ) : null}

      {/* A skeleton grid rather than a line of text, so the page does not jump
          when the real cards arrive. */}
      {!movies && !error ? <MovieSkeletons /> : null}

      {movies && movies.length === 0 ? (
        <div className="empty card">
          <p className="empty__title">Nothing is showing yet</p>
          <p>Run the seed script to fill the catalogue.</p>
        </div>
      ) : null}

      {movies && movies.length > 0 ? (
        <ul className="movie-grid">
          {movies.map((movie) => (
            <li key={movie.id}>
              <Link className="card movie-card" to={`/movies/${movie.id}`}>
                <Poster movie={movie} />

                <div className="movie-card__body">
                  <span className="movie-card__title">{movie.title}</span>
                  <span className="movie-card__meta">
                    {movie.language} · {movie.duration_minutes} min
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function MovieSkeletons() {
  return (
    <ul className="movie-grid" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <li key={i}>
          <div className="card movie-card">
            <div className="poster skeleton" />
            <div className="movie-card__body">
              <div className="skeleton skeleton--text" style={{ width: '75%' }} />
              <div className="skeleton skeleton--text" style={{ width: '50%' }} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
