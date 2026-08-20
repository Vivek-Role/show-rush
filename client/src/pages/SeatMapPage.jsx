import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { createBooking } from '../api/bookings.js';
import { request } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { BookingResult } from '../booking/BookingResult.jsx';
import { BookingSummary } from '../booking/BookingSummary.jsx';
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
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [booking, setBooking] = useState(null);
  const [bookingError, setBookingError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Stops an older in-flight request from overwriting a newer one when the
  // seat map is reloaded after a conflict.
  const requestSeq = useRef(0);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      const seq = (requestSeq.current += 1);
      if (!silent) setData(null);
      setError(null);

      try {
        // One request. The show, the screen with its layout, and every seat
        // with its status and price arrive together — there is no second call,
        // and no second place that decides whether a seat is taken.
        const payload = await request(`/api/shows/${id}/seatmap`);
        if (seq === requestSeq.current) setData(payload);
      } catch (err) {
        if (seq === requestSeq.current) setError(err.message);
      }
    },
    [id],
  );

  useEffect(() => {
    load();
  }, [load]);

  const seats = data?.seats ?? NO_SEATS;

  // Rebuilt only when a new payload arrives, not on every render. This is the
  // index, not a rendering optimisation: Module 3.5 measures the straightforward
  // DOM implementation, so no seat memoisation is introduced here.
  const index = useMemo(() => buildSeatIndex(seats), [seats]);

  // All selection state lives in the hook. This page owns it and passes it
  // down; nothing below holds a selection of its own.
  const selection = useSeatSelection({ seats, maxSeats: MAX_SEATS });
  const { toggle, selectedIds } = selection;

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedSeats = useMemo(
    () => seats.filter((seat) => selectedIdSet.has(seat.id)),
    [seats, selectedIdSet],
  );

  // Signing in unmounts this page, so the chosen seats travel with the redirect
  // and are re-applied on the way back. toggle() re-validates every one of
  // them, so a seat that was taken while the visitor was logging in is simply
  // not restored rather than silently resurrected.
  const restoreIds = location.state?.seatIds;
  useEffect(() => {
    if (!data || !restoreIds?.length) return;

    for (const seatId of restoreIds) toggle(seatId);

    // Consume the handoff, so a later refresh does not re-apply it.
    navigate(location.pathname, { replace: true, state: null });
  }, [data, restoreIds, toggle, navigate, location.pathname]);

  const goToLogin = useCallback(() => {
    navigate('/login', { state: { from: location.pathname, seatIds: selectedIds } });
  }, [navigate, location.pathname, selectedIds]);

  async function onProceed() {
    // The server is what actually requires a session; this only saves the
    // visitor a round trip that would end in a 401.
    if (!user) {
      goToLogin();
      return;
    }

    setBusy(true);
    setBookingError(null);

    try {
      const payload = await createBooking({ showId: id, seatIds: selectedIds });
      setBooking(payload.booking);
      selection.clear();
      await load({ silent: true });
    } catch (err) {
      // Branch on the stable code, never on the message.
      switch (err.code) {
        case 'SEATS_UNAVAILABLE':
          setBookingError('One or more of those seats were just taken. The map has been refreshed.');
          // Refetching is what clears them: once the server reports those seats
          // as unavailable, the selection hook stops counting them.
          await load({ silent: true });
          break;

        case 'UNAUTHENTICATED':
          // The session expired underneath us. Drop it and send them to log in
          // with their seats intact.
          await logout();
          goToLogin();
          break;

        case 'NOT_FOUND':
          navigate(`/movies/${data.show.movie.id}`, { replace: true });
          break;

        case 'VALIDATION_ERROR':
          // Reachable only via a client bug; showing the server's own message
          // beats inventing a friendlier one that hides it.
          setBookingError(err.message);
          break;

        default:
          setBookingError('Booking failed. Nothing was reserved — you can try again.');
      }
    } finally {
      setBusy(false);
    }
  }

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
        onToggle={toggle}
        limitReached={selection.limitReached}
      />
      <Legend tiers={data.screen.layout.tiers} tierPrices={index.tierPrices} />

      <BookingSummary
        seats={selectedSeats}
        breakdown={selection.breakdown}
        totalPaise={selection.totalPaise}
        count={selection.count}
        limitReached={selection.limitReached}
        maxSeats={MAX_SEATS}
        busy={busy}
        signedIn={Boolean(user)}
        onProceed={onProceed}
        onClear={selection.clear}
        error={bookingError}
      />

      {booking ? <BookingResult booking={booking} onDismiss={() => setBooking(null)} /> : null}
    </>
  );
}
