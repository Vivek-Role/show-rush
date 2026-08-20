import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { request } from '../api/client.js';
import { formatPaise } from '../money.js';
import { Legend } from '../seatmap/Legend.jsx';
import { SeatMap } from '../seatmap/SeatMap.jsx';
import { buildSeatIndex } from '../seatmap/seatIndex.js';
import { useSeatSelection } from '../seatmap/useSeatSelection.js';

// The server enforces this in validate.js; the client repeats it so the sixth
// seat is the last one that highlights rather than the first 400.
const MAX_SEATS = 6;

// Stable identity for the empty case, so the selection hook is not handed a new
// array on every render while the payload is still loading.
const NO_SEATS = [];

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
  const index = useMemo(() => buildSeatIndex(data?.seats ?? NO_SEATS), [data]);

  // All selection state lives in the hook. This page owns it and passes it
  // down; nothing below holds a selection of its own.
  const selection = useSeatSelection({ seats: data?.seats ?? NO_SEATS, maxSeats: MAX_SEATS });

  if (error) return <p>{error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <>
      <h1>{data.show.movie.title}</h1>
      <p>
        {TIME_FORMAT.format(new Date(data.show.starts_at))} · {data.screen.name} ·{' '}
        {data.screen.cinema_name}
      </p>

      <SeatMap
        layout={data.screen.layout}
        seatAt={index.seatAt}
        isSelected={selection.isSelected}
        onToggle={selection.toggle}
        limitReached={selection.limitReached}
      />
      <Legend tiers={data.screen.layout.tiers} tierPrices={index.tierPrices} />

      {/* Announced rather than silently changing, so a screen reader hears the
          running total the same way a sighted user sees it. */}
      <p className="selection" aria-live="polite">
        {selection.count === 0
          ? 'No seats selected'
          : `${selection.count} seat${selection.count === 1 ? '' : 's'} selected · ${formatPaise(
              selection.totalPaise,
            )}`}
        {selection.count > 0 ? (
          <>
            {' '}
            <button type="button" onClick={selection.clear}>
              Clear
            </button>
          </>
        ) : null}
      </p>

      {selection.limitReached ? (
        <p className="selection__limit">{MAX_SEATS} seats maximum.</p>
      ) : null}

      {/* The price breakdown, the proceed button and the booking call are 3.4. */}
    </>
  );
}
