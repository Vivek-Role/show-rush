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
    <section className="card booking-result" role="status">
      <div className="card__body">
        <div className="booking-result__head">
          <div>
            <p className="booking-result__eyebrow">{paid ? 'Paid' : 'Booked'}</p>
            <h2 className="booking-result__ref">{booking.booking_ref}</h2>
          </div>
          <span className={`badge ${paid ? 'badge--paid' : 'badge--pending'}`}>
            {booking.status}
          </span>
        </div>

        <p className="booking-result__seats">
          {booking.seats.map((seat) => (
            <span className="chip chip--seat" key={seat.id}>
              {seat.row_label}
              {seat.seat_number}
            </span>
          ))}
        </p>

        <p className="booking-result__total">{formatPaise(booking.total_paise)}</p>

        {/* Saying this plainly matters: until the payment is confirmed the seats
            are claimed in the database but nobody has paid for them. */}
        {paid ? null : (
          <p className="note note--warn booking-result__pending">
            The seats are yours, but nothing has been paid yet.
          </p>
        )}

        {payError ? (
          <p className="booking-result__error note note--error" role="alert">
            {payError}
          </p>
        ) : null}

        <div className="booking-result__actions">
          {/* Pressing Pay twice replays the *same* payment event, which is the
              whole point: the second press changes nothing and the server answers
              from what it already recorded. */}
          {paid ? null : (
            <button
              type="button"
              className="btn btn--primary btn--lg"
              onClick={onPay}
              disabled={paying}
            >
              {paying ? 'Paying…' : `Pay ${formatPaise(booking.total_paise)}`}
            </button>
          )}
          <button type="button" className="btn" onClick={onDismiss}>
            {paid ? 'Done' : 'Dismiss'}
          </button>
        </div>
      </div>
    </section>
  );
}
