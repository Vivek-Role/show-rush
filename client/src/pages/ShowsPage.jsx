import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { request } from '../api/client.js';

// Times come back as timestamptz and are rendered in the viewer's own zone,
// which is why the zone is shown rather than implied.
//
// Spelled out field by field rather than with dateStyle/timeStyle: ECMA-402
// rejects combining those shorthands with timeZoneName, and the constructor
// throws at module load — which takes the whole route down with it.
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

export function ShowsPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);

    request(`/api/movies/${id}/shows`)
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <p>{error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <>
      <h1>{data.movie.title}</h1>
      <p>{data.movie.description}</p>

      <h2>Shows</h2>
      <ul>
        {data.shows.map((show) => (
          <li key={show.id}>
            <Link to={`/shows/${show.id}`}>
              {TIME_FORMAT.format(new Date(show.starts_at))} · {show.screen.name}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
