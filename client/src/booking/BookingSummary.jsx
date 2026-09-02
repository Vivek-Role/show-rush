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
  const holding = !(secondsLeft === null || secondsLeft === undefined || count === 0);
  // Under a minute the countdown stops being background information.
  const urgent = holding && secondsLeft <= 60;

  return (
    <section className="card summary">
      <div className="card__body">
        <div className="summary__head">
          <h2>Your seats</h2>
          {count > 0 ? (
            <button type="button" className="btn btn--ghost btn--sm summary__clear" onClick={onClear}>
              Clear
            </button>
          ) : null}
        </div>

        {/* Announced rather than silently changing, so a screen reader hears the
            running total the same way a sighted user sees it. */}
        <p className="selection" aria-live="polite">
          {count === 0
            ? 'No seats selected yet.'
            : `${count} seat${count === 1 ? '' : 's'} selected`}
        </p>

        {count > 0 ? (
          <p className="summary__seats">
            {seats.map((seat) => (
              <span className="chip chip--seat" key={seat.id}>
                {seat.row_label}
                {seat.seat_number}
              </span>
            ))}
          </p>
        ) : null}

        {limitReached ? (
          <p className="selection__limit note note--warn">{maxSeats} seats maximum.</p>
        ) : null}

        {/* Only while something is actually held. Announced politely rather than
            assertively: a ticking clock read out every second would be unusable. */}
        {holding ? (
          <p
            className={`selection__hold${urgent ? ' selection__hold--urgent' : ''}`}
            aria-live="polite"
          >
            <span aria-hidden="true">⏱</span> Seats held for{' '}
            <strong>{formatCountdown(secondsLeft)}</strong>
          </p>
        ) : null}

        {count > 0 ? (
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
              <tr className="summary__total">
                <td>Total</td>
                <td />
                <td>{formatPaise(totalPaise)}</td>
              </tr>
            </tbody>
          </table>
        ) : null}

        {error ? (
          <p className="summary__error note note--error" role="alert">
            {error}
          </p>
        ) : null}

        {/* Signed out, this routes to login and comes back to this show rather
            than refusing — the server is what actually requires the session. */}
        <button
          type="button"
          className="btn btn--primary btn--lg btn--block"
          onClick={onProceed}
          disabled={count === 0 || busy}
        >
          {busy
            ? 'Booking…'
            : !signedIn
              ? 'Log in to book'
              : count === 0
                ? 'Select seats to continue'
                : `Proceed · ${formatPaise(totalPaise)}`}
        </button>
      </div>
    </section>
  );
}
