import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { request } from '../api/client.js';
import { useCity } from '../city/CityContext.jsx';
import { Poster } from '../Poster.jsx';

// Times come back as timestamptz and are rendered in the viewer's own zone,
// which is why the zone is shown rather than implied.
//
// Spelled out field by field rather than with dateStyle/timeStyle: ECMA-402
// rejects combining those shorthands with timeZoneName, and the constructor
// throws at module load — which takes the whole route down with it.
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});

const ZONE =
  new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(new Date())
    .find((part) => part.type === 'timeZoneName')?.value ?? '';

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const DAY_NUMBER = new Intl.DateTimeFormat(undefined, { day: '2-digit' });
const MONTH = new Intl.DateTimeFormat(undefined, { month: 'short' });
const FULL_DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

// Time-of-day bands, by local hour. Derived from starts_at, which the payload
// already carries — no filter here invents a field the API does not send.
const TIME_BANDS = [
  { id: 'morning', label: 'Morning', hint: 'before 12', match: (h) => h < 12 },
  { id: 'afternoon', label: 'Afternoon', hint: '12–4', match: (h) => h >= 12 && h < 16 },
  { id: 'evening', label: 'Evening', hint: '4–8', match: (h) => h >= 16 && h < 20 },
  { id: 'night', label: 'Night', hint: 'after 8', match: (h) => h >= 20 },
];

// The one format the seeded data actually distinguishes, and it is spelled out
// in the screen's own name. Read from the name rather than assumed, so a screen
// that is not IMAX is simply "standard" instead of being mislabelled.
function formatOf(screenName) {
  return /imax/i.test(screenName) ? 'IMAX' : 'Standard';
}

function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function ShowsPage() {
  const { id } = useParams();
  const { city } = useCity();

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  const [selectedDay, setSelectedDay] = useState(null);
  const [band, setBand] = useState('all');
  const [format, setFormat] = useState('all');

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
  }, [id, attempt]);

  useEffect(() => {
    if (!data) return undefined;
    const previous = document.title;
    document.title = `${data.movie.title} · Show-Rush`;
    return () => {
      document.title = previous;
    };
  }, [data]);

  // Every day that actually has a show, in order. The strip is built from the
  // schedule rather than from a calendar: offering dates with nothing on them
  // would be inventing availability.
  const days = useMemo(() => {
    if (!data) return [];

    const byKey = new Map();

    for (const show of data.shows) {
      const date = new Date(show.starts_at);
      const key = dayKey(date);
      const bucket = byKey.get(key);

      if (bucket) bucket.shows.push(show);
      else byKey.set(key, { key, date, shows: [show] });
    }

    return [...byKey.values()].sort((a, b) => a.date - b.date);
  }, [data]);

  // The first day with shows, until the visitor picks another. Reset whenever
  // the film changes, so a stale date from another film cannot hide its shows.
  useEffect(() => {
    setSelectedDay(days.length > 0 ? days[0].key : null);
    setBand('all');
    setFormat('all');
  }, [days]);

  const dayShows = useMemo(
    () => days.find((day) => day.key === selectedDay)?.shows ?? [],
    [days, selectedDay],
  );

  // Which formats exist on the selected day — the filter only offers what is
  // actually there.
  const formatsToday = useMemo(
    () => [...new Set(dayShows.map((show) => formatOf(show.screen.name)))],
    [dayShows],
  );

  const filtered = useMemo(
    () =>
      dayShows.filter((show) => {
        const hour = new Date(show.starts_at).getHours();
        const matchesBand =
          band === 'all' || TIME_BANDS.find((candidate) => candidate.id === band)?.match(hour);
        const matchesFormat = format === 'all' || formatOf(show.screen.name) === format;

        return matchesBand && matchesFormat;
      }),
    [dayShows, band, format],
  );

  // Grouped by the venue the API actually exposes.
  //
  // The seeded catalogue has one cinema, and this endpoint returns the screen
  // without its cinema — screens.cinema_name reaches the client only through
  // the seat map. So a screen is the venue here, which is the honest unit
  // rather than a cinema row invented on the client.
  const venues = useMemo(() => {
    const byScreen = new Map();

    for (const show of filtered) {
      const key = show.screen.id;
      const bucket = byScreen.get(key);

      if (bucket) bucket.shows.push(show);
      else byScreen.set(key, { screen: show.screen, shows: [show] });
    }

    for (const venue of byScreen.values()) {
      venue.shows.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    }

    return [...byScreen.values()].sort((a, b) => a.screen.name.localeCompare(b.screen.name));
  }, [filtered]);

  const filtersActive = band !== 'all' || format !== 'all';

  if (error) {
    return (
      <div className="stack">
        <Link className="backlink" to="/">
          ← All films
        </Link>
        <p className="note note--error" role="alert">
          <span>{error}</span>
          <span className="note__spacer" />
          <button type="button" className="btn btn--sm" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      </div>
    );
  }

  if (!data) return <ShowsSkeleton />;

  return (
    <div className="stack">
      <Link className="backlink" to="/">
        ← All films
      </Link>

      <div className="movie-hero">
        <Poster movie={data.movie} />

        <div>
          <h1>{data.movie.title}</h1>

          <div className="movie-hero__meta">
            {data.movie.language ? <span className="chip">{data.movie.language}</span> : null}
            {data.movie.certificate ? <span className="chip">{data.movie.certificate}</span> : null}
            {data.movie.duration_minutes ? (
              <span className="chip">{data.movie.duration_minutes} min</span>
            ) : null}
          </div>

          {data.movie.description ? (
            <p className="movie-hero__description">{data.movie.description}</p>
          ) : null}
        </div>
      </div>

      {days.length === 0 ? (
        <div className="empty card">
          <p className="empty__title">No showtimes scheduled</p>
          <p>Check back later, or pick another film.</p>
        </div>
      ) : (
        <>
          {/* Date strip. Horizontally scrollable rather than wrapped, so a long
              run of dates behaves the same on a phone as on a desktop. */}
          <div className="datestrip" role="group" aria-label="Choose a date">
            {days.map((day) => {
              const active = day.key === selectedDay;
              return (
                <button
                  key={day.key}
                  type="button"
                  className={`datechip${active ? ' datechip--active' : ''}`}
                  aria-pressed={active}
                  aria-label={FULL_DAY.format(day.date)}
                  onClick={() => setSelectedDay(day.key)}
                >
                  <span className="datechip__dow">{WEEKDAY.format(day.date).toUpperCase()}</span>
                  <span className="datechip__day">{DAY_NUMBER.format(day.date)}</span>
                  <span className="datechip__mon">{MONTH.format(day.date).toUpperCase()}</span>
                </button>
              );
            })}
          </div>

          <div className="filters card">
            <div className="card__body filters__body">
              <div className="filters__group">
                <span className="filters__label" id="filter-time">
                  Time
                </span>
                <div className="filters__chips" role="group" aria-labelledby="filter-time">
                  <FilterChip active={band === 'all'} onClick={() => setBand('all')}>
                    Any
                  </FilterChip>
                  {TIME_BANDS.map((candidate) => (
                    <FilterChip
                      key={candidate.id}
                      active={band === candidate.id}
                      onClick={() => setBand(candidate.id)}
                    >
                      {candidate.label}
                    </FilterChip>
                  ))}
                </div>
              </div>

              {/* Only offered when the day actually has more than one format. */}
              {formatsToday.length > 1 ? (
                <div className="filters__group">
                  <span className="filters__label" id="filter-format">
                    Format
                  </span>
                  <div className="filters__chips" role="group" aria-labelledby="filter-format">
                    <FilterChip active={format === 'all'} onClick={() => setFormat('all')}>
                      Any
                    </FilterChip>
                    {formatsToday.map((candidate) => (
                      <FilterChip
                        key={candidate}
                        active={format === candidate}
                        onClick={() => setFormat(candidate)}
                      >
                        {candidate}
                      </FilterChip>
                    ))}
                  </div>
                </div>
              ) : null}

              {filtersActive ? (
                <button
                  type="button"
                  className="btn btn--sm filters__clear"
                  onClick={() => {
                    setBand('all');
                    setFormat('all');
                  }}
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          </div>

          <p className="venues__count" aria-live="polite">
            {venues.length === 0
              ? 'No shows match these filters'
              : `${filtered.length} show${filtered.length === 1 ? '' : 's'} at ${venues.length} ` +
                `screen${venues.length === 1 ? '' : 's'} in ${city}`}
          </p>

          {venues.length === 0 ? (
            <div className="empty card">
              <p className="empty__title">Nothing at this time</p>
              <p>Try another date, or clear the filters.</p>
            </div>
          ) : (
            <ul className="venues">
              {venues.map((venue) => (
                <li key={venue.screen.id} className="card venue">
                  <div className="card__body">
                    <div className="venue__head">
                      <div>
                        <h2 className="venue__name">{venue.screen.name}</h2>
                        <p className="venue__meta">
                          {data.movie.language} · {ZONE ? `times in ${ZONE}` : 'local time'}
                        </p>
                      </div>
                      <span className="chip venue__format">{formatOf(venue.screen.name)}</span>
                    </div>

                    <ul className="showtimes">
                      {venue.shows.map((show) => (
                        <li key={show.id}>
                          <Link
                            className="showtime-chip"
                            to={`/shows/${show.id}`}
                            aria-label={`${TIME_FORMAT.format(new Date(show.starts_at))} at ${
                              venue.screen.name
                            }`}
                          >
                            {TIME_FORMAT.format(new Date(show.starts_at))}
                          </Link>
                        </li>
                      ))}
                    </ul>

                    <p className="venue__note">Seats are held for seven minutes at checkout.</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      className={`filterchip${active ? ' filterchip--active' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ShowsSkeleton() {
  return (
    <div className="stack" aria-hidden="true">
      <div className="skeleton skeleton--text" style={{ width: '6rem' }} />
      <div className="movie-hero">
        <div className="poster skeleton" />
        <div style={{ width: '100%' }}>
          <div className="skeleton skeleton--text" style={{ width: '55%', height: '1.4rem' }} />
          <div className="skeleton skeleton--text" style={{ width: '80%' }} />
          <div className="skeleton skeleton--text" style={{ width: '65%' }} />
        </div>
      </div>
      <div className="datestrip">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton" style={{ width: '4rem', height: '4.25rem' }} />
        ))}
      </div>
      <div className="skeleton" style={{ height: '8rem', borderRadius: '0.75rem' }} />
    </div>
  );
}
