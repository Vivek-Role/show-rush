// Paise to rupees, kept local to the legend on purpose. Module 3.3 introduces
// client/src/money.js as a shared helper; pulling that file forward now would
// move a module boundary for one call site.
function rupees(paise) {
  // A tier with no configured price for this show yields null from the
  // show_prices LEFT JOIN. Say so, rather than printing ₹0 or NaN.
  if (paise == null) return '—';
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}

// Tier order comes from the layout, which is the presentation source. A tier
// listed there but absent from the seats simply has no price to show.
export function Legend({ tiers, tierPrices }) {
  return (
    <ul className="legend">
      {tiers.map((tier) => (
        <li className="legend__item" key={tier}>
          <span className="legend__swatch" data-tier={tier} aria-hidden="true" />
          <span className="legend__tier">{tier}</span>
          <span className="legend__price">{rupees(tierPrices.get(tier))}</span>
        </li>
      ))}

      <li className="legend__item">
        <span className="legend__swatch" data-status="booked" aria-hidden="true" />
        <span className="legend__tier">unavailable</span>
      </li>
    </ul>
  );
}
