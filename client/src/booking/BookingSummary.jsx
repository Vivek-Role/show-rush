import { formatPaise } from '../money.js';

// What is selected, what it costs, and the one button that turns it into a
// booking. Holds no state: everything arrives from the selection hook via
// SeatMapPage.
export function BookingSummary({
  seats,
  breakdown,
  totalPaise,
  count,
  limitReached,
  maxSeats,
  busy,
  signedIn,
  onProceed,
  onClear,
  error,
}) {
  return (
    <section className="summary">
      {/* Announced rather than silently changing, so a screen reader hears the
          running total the same way a sighted user sees it. */}
      <p className="selection" aria-live="polite">
        {count === 0
          ? 'No seats selected'
          : `${count} seat${count === 1 ? '' : 's'} selected · ${formatPaise(totalPaise)}`}
        {count > 0 ? (
          <>
            {' '}
            <button type="button" onClick={onClear}>
              Clear
            </button>
          </>
        ) : null}
      </p>

      {limitReached ? <p className="selection__limit">{maxSeats} seats maximum.</p> : null}

      {count > 0 ? (
        <>
          <p className="summary__seats">
            {seats.map((seat) => `${seat.row_label}${seat.seat_number}`).join(', ')}
          </p>

          <table className="summary__breakdown">
            <tbody>
              {breakdown.map((row) => (
                <tr key={row.tier}>
                  <td>{row.tier}</td>
                  <td>
                    {row.count} × {formatPaise(row.unitPaise)}
                  </td>
                  <td>{formatPaise(row.subtotalPaise)}</td>
                </tr>
              ))}
              <tr>
                <td>total</td>
                <td />
                <td>{formatPaise(totalPaise)}</td>
              </tr>
            </tbody>
          </table>
        </>
      ) : null}

      {error ? (
        <p className="summary__error" role="alert">
          {error}
        </p>
      ) : null}

      {/* Signed out, this routes to login and comes back to this show rather
          than refusing — the server is what actually requires the session. */}
      <button type="button" onClick={onProceed} disabled={count === 0 || busy}>
        {busy ? 'Booking…' : signedIn ? 'Proceed' : 'Log in to book'}
      </button>
    </section>
  );
}
