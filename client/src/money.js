// Money is carried as integer paise everywhere — in the database, over the
// API, and through the selection hook. This file is the one place that turns it
// into something a person reads, which makes it the one place a division by 100
// is allowed to happen.

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatPaise(paise) {
  // A tier with no configured price for this show yields null from the
  // show_prices LEFT JOIN. Say so, rather than printing a confident zero.
  if (paise == null) return '—';
  return INR.format(paise / 100);
}
