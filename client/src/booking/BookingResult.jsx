import { formatPaise } from '../money.js';

// The booking that came back from the server, shown exactly as the server
// described it — the reference, the seats it actually claimed, and the total it
// actually charged. Nothing here is recomputed on the client.
export function BookingResult({ booking, onDismiss }) {
  return (
    <section className="booking-result" role="status">
      <h2>Booked — {booking.booking_ref}</h2>

      <p>
        {booking.seats.map((seat) => `${seat.row_label}${seat.seat_number}`).join(', ')} ·{' '}
        {formatPaise(booking.total_paise)}
      </p>

      {/* Saying this plainly matters: the seats are held by the database, but
          nobody has paid for them. Payment is Phase 5. */}
      <p>
        Status: <strong>{booking.status}</strong> — not paid yet. Payment arrives in Phase 5.
      </p>

      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}
