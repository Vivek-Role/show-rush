import { formatPaise } from '../money.js';

function formatCountdown(seconds) {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

// The checkout state, pinned to the bottom of a phone screen.
//
// On a narrow viewport the summary sits below a seat map taller than the
// screen, so the total, the countdown and the button are all out of sight at
// exactly the moment they matter. This is the same state and the same action,
// kept where a thumb can reach it. Hidden entirely on desktop, where the
// sidebar already does the job.
//
// NO aria-live here on purpose. BookingSummary already announces the running
// total; a second live region repeating it would have a screen reader say
// everything twice.
export function CheckoutBar({ count, totalPaise, secondsLeft, busy, signedIn, onProceed }) {
  // Nothing chosen yet means nothing to confirm — the bar would be a permanent
  // strip of empty chrome over the map.
  if (count === 0) return null;

  const holding = secondsLeft !== null && secondsLeft !== undefined;
  const urgent = holding && secondsLeft <= 60;

  return (
    <div className="checkout-bar">
      <div className="checkout-bar__facts">
        <div className="checkout-bar__total">{formatPaise(totalPaise)}</div>
        <div className={`checkout-bar__meta${urgent ? ' checkout-bar__meta--urgent' : ''}`}>
          {count} seat{count === 1 ? '' : 's'}
          {holding ? ` · held ${formatCountdown(secondsLeft)}` : ''}
        </div>
      </div>

      <button type="button" className="btn btn--primary btn--lg" onClick={onProceed} disabled={busy}>
        {busy ? 'Booking…' : signedIn ? 'Proceed' : 'Log in'}
      </button>
    </div>
  );
}
