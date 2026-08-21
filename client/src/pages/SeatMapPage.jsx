import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { createBooking } from '../api/bookings.js';
import { request } from '../api/client.js';
import { confirmPayment } from '../api/payments.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { BookingResult } from '../booking/BookingResult.jsx';
import { BookingSummary } from '../booking/BookingSummary.jsx';
import { Legend } from '../seatmap/Legend.jsx';
import { SeatMap } from '../seatmap/SeatMap.jsx';
import { buildSeatIndex } from '../seatmap/seatIndex.js';
import { useSeatHolds } from '../seatmap/useSeatHolds.js';
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
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState(null);

  // One payment event id per booking, generated when the booking is created and
  // kept until it is dismissed. Pressing Pay a second time therefore replays the
  // same event rather than starting a new one — which is what makes the
  // idempotency layer visible in the browser instead of only under k6.
  const paymentEventRef = useRef(null);

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
  const { toggle, selectedIds, isSelected, limitReached, clear } = selection;

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedSeats = useMemo(
    () => seats.filter((seat) => selectedIdSet.has(seat.id)),
    [seats, selectedIdSet],
  );

  // A hold expiring is not an error the visitor caused, so it is said plainly
  // and the seats go back on the map. They were never theirs to keep.
  const onHoldExpired = useCallback(() => {
    clear();
    setBookingError('Your seat hold expired. Those seats are available to everyone again.');
    void load({ silent: true });
  }, [clear, load]);

  const holds = useSeatHolds({ showId: id, enabled: Boolean(user), onExpire: onHoldExpired });
  const { hold, release, releaseAll, restore } = holds;

  // Selecting a seat is what takes the hold, which is what makes two tabs
  // unable to hold the same seat. Signed out there is no hold to take — the
  // selection still works, and the server refuses the booking anyway.
  const onSeatToggle = useCallback(
    async (seatId) => {
      const wasSelected = isSelected(seatId);

      // The hook refuses the seventh seat. Asking the server to hold one it is
      // about to refuse would take a seat nobody gets to use.
      if (!wasSelected && limitReached) return;

      toggle(seatId);
      if (!user) return;

      if (wasSelected) {
        void release([seatId]);
        return;
      }

      const result = await hold([seatId]);
      if (result.ok) return;

      // Put the seat back the way it was. The selection is local, the hold is
      // authoritative, and the two must not disagree.
      toggle(seatId);
      setBookingError(result.message);
      await load({ silent: true });
    },
    [isSelected, limitReached, toggle, user, hold, release, load],
  );

  // After a refresh the seat ids come from sessionStorage and their validity
  // from the server. Only what it confirms is re-selected.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!data || !user || restoredRef.current) return;
    restoredRef.current = true;

    void restore().then((confirmed) => {
      for (const seatId of confirmed) toggle(seatId);
    });
  }, [data, user, restore, toggle]);

  // Signing in unmounts this page, so the chosen seats travel with the redirect
  // and are re-applied on the way back. toggle() re-validates every one of
  // them, so a seat that was taken while the visitor was logging in is simply
  // not restored rather than silently resurrected.
  const restoreIds = location.state?.seatIds;
  useEffect(() => {
    if (!data || !restoreIds?.length) return;

    for (const seatId of restoreIds) toggle(seatId);

    // The seats were chosen before there was a session to hold them with, so
    // the hold is taken now. A seat someone else took in the meantime is
    // refused here and dropped by the refetch, exactly as a click would be.
    if (user) {
      void hold(restoreIds).then((result) => {
        if (result.ok) return;
        setBookingError(result.message);
        return load({ silent: true });
      });
    }

    // Consume the handoff, so a later refresh does not re-apply it.
    navigate(location.pathname, { replace: true, state: null });
  }, [data, restoreIds, toggle, navigate, location.pathname, user, hold, load]);

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
      paymentEventRef.current = crypto.randomUUID();
      setPayError(null);
      setBooking(payload.booking);
      clear();

      // The booking is committed, so the hold has done its job. Released after
      // the fact and best effort: a hold outliving its booking is harmless —
      // the seat is already sold — which is why nothing here waits on it.
      void releaseAll();

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

  // Module 5.5. The event id comes from the ref, so a second press is a replay
  // of the first event and not a new payment. The server decides what that
  // means; this only reports the answer.
  async function onPay() {
    if (!booking || paying) return;

    setPaying(true);
    setPayError(null);

    try {
      const payload = await confirmPayment({
        bookingRef: booking.booking_ref,
        paymentEventId: paymentEventRef.current,
      });

      // The payment response describes the booking without its seats, so the
      // status is taken from the server and the seats stay as booked.
      setBooking((current) => ({ ...current, status: payload.booking.status }));

      // A paid seat is a booked seat, and the map already showed it that way.
      // Refreshed anyway so nothing on screen is older than the payment.
      await load({ silent: true });
    } catch (err) {
      // Branch on the stable code, never on the message.
      switch (err.code) {
        case 'PAYMENT_FAILED':
          setPayError('The payment did not go through. The seats are still yours — try again.');
          break;

        case 'BOOKING_NOT_PENDING':
          setPayError('That booking can no longer be paid for.');
          break;

        case 'UNAUTHENTICATED':
          await logout();
          goToLogin();
          break;

        default:
          setPayError('Payment failed. Nothing was charged — you can try again.');
      }
    } finally {
      setPaying(false);
    }
  }

  function onDismissBooking() {
    paymentEventRef.current = null;
    setPayError(null);
    setBooking(null);
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
        onToggle={onSeatToggle}
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
        secondsLeft={holds.secondsLeft}
        onProceed={onProceed}
        onClear={selection.clear}
        error={bookingError}
      />

      {booking ? (
        <BookingResult
          booking={booking}
          onPay={onPay}
          paying={paying}
          payError={payError}
          onDismiss={onDismissBooking}
        />
      ) : null}
    </>
  );
}
