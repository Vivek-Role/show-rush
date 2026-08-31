import { formatPaise } from '../money.js';

// The number itself comes from the server's TTL — this only decides how it
// reads. m:ss, because "419 seconds" is not how anyone thinks about a wait.
function formatCountdown(seconds) {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

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
  secondsLeft,
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

      {/* Only while something is actually held. Announced politely rather than
          assertively: a ticking clock read out every second would be unusable. */}
      {secondsLeft === null || secondsLeft === undefined || count === 0 ? null : (
        <p className="selection__hold" aria-live="polite">
          Seats held for {formatCountdown(secondsLeft)}
        </p>
      )}

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
