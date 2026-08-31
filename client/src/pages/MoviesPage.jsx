import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from '../api/client.js';

export function MoviesPage() {
  const [movies, setMovies] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

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
  }, []);

  if (error) return <p>{error}</p>;
  if (!movies) return <p>Loading…</p>;

  return (
    <>
      <h1>Now showing</h1>
      <ul>
        {movies.map((movie) => (
          <li key={movie.id}>
            <Link to={`/movies/${movie.id}`}>{movie.title}</Link>{' '}
            <small>
              {movie.language} · {movie.certificate} · {movie.duration_minutes} min
            </small>
          </li>
        ))}
      </ul>
    </>
  );
}
