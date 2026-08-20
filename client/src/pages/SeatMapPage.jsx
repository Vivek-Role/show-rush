import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { request } from '../api/client.js';
import { Legend } from '../seatmap/Legend.jsx';
import { SeatMap } from '../seatmap/SeatMap.jsx';
import { buildSeatIndex } from '../seatmap/seatIndex.js';

// Field by field rather than dateStyle/timeStyle: ECMA-402 rejects combining
// those shorthands with timeZoneName, and the constructor throws at module
// load, which takes the whole route down with it.
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

export function SeatMapPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);

    // One request. The show, the screen with its layout, and every seat with
    // its status and price arrive together — there is no second call, and no
    // second place that decides whether a seat is taken.
    request(`/api/shows/${id}/seatmap`)
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

  // Rebuilt only when a new payload arrives, not on every render. This is the
  // index, not a rendering optimisation: Module 3.5 measures the straightforward
  // DOM implementation, so no seat memoisation is introduced here.
  const index = useMemo(() => buildSeatIndex(data?.seats ?? []), [data]);

  if (error) return <p>{error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <>
      <h1>{data.show.movie.title}</h1>
      <p>
        {TIME_FORMAT.format(new Date(data.show.starts_at))} · {data.screen.name} ·{' '}
        {data.screen.cinema_name}
      </p>

      <SeatMap layout={data.screen.layout} seatAt={index.seatAt} />
      <Legend tiers={data.screen.layout.tiers} tierPrices={index.tierPrices} />

      {/* Selecting seats is Module 3.3; the summary and booking are 3.4. */}
    </>
  );
}
