import { formatPaise } from '../money.js';

// The booking that came back from the server, shown exactly as the server
// described it — the reference, the seats it actually claimed, and the total it
// actually charged. Nothing here is recomputed on the client.
//
// Module 5.5 adds the payment step. The status shown is always the server's
// own: this component never guesses that a payment succeeded.
export function BookingResult({ booking, onPay, paying, payError, onDismiss }) {
  const paid = booking.status === 'paid';

  return (
    <section className="booking-result" role="status">
      <h2>Booked — {booking.booking_ref}</h2>

      <p>
        {booking.seats.map((seat) => `${seat.row_label}${seat.seat_number}`).join(', ')} ·{' '}
        {formatPaise(booking.total_paise)}
      </p>

      {/* Saying this plainly matters: until the payment is confirmed the seats
          are claimed in the database but nobody has paid for them. */}
      <p>
        Status: <strong>{booking.status}</strong>
        {paid ? null : ' — the seats are yours, but nothing has been paid yet.'}
      </p>

      {payError ? (
        <p className="booking-result__error" role="alert">
          {payError}
        </p>
      ) : null}

      {/* Pressing Pay twice replays the *same* payment event, which is the
          whole point: the second press changes nothing and the server answers
          from what it already recorded. */}
      {paid ? null : (
        <button type="button" onClick={onPay} disabled={paying}>
          {paying ? 'Paying…' : `Pay ${formatPaise(booking.total_paise)}`}
        </button>
      )}{' '}
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}
