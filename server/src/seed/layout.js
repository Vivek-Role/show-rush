// One generator, two outputs: the presentation layout stored on screens.layout,
// and the flat seat list inserted into seats. They come from the same pass, so
// they cannot drift.
//
// seats is authoritative for which seats exist and every foreign key points at
// it. The layout describes only how to draw them — rows, columns, tiers, and
// where the aisles fall.

// Bijective base-26: A…Z, then AA, AB, … AZ, BA, and so on.
//
// A single letter was enough while the largest screen had thirteen rows, but
// the stress layout has a hundred. Past index 25 the old version emitted '[',
// '\', ']' and then lowercase — punctuation in seats.row_label, which is the
// authoritative table, and unparseable by the seat references in data.js.
//
// Indices 0–25 are unchanged, so every existing screen seeds byte-identically.
function rowLabel(index) {
  let label = '';
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) {
    label = String.fromCharCode(65 + (n % 26)) + label;
  }
  return label;
}

// Parameterised so a larger variant is a different call rather than a rewrite.
export function generateScreenLayout({ seatsPerRow, aislesAfterColumn, tierBands }) {
  const rows = [];
  const seats = [];

  for (const band of tierBands) {
    for (let inBand = 0; inBand < band.rows; inBand += 1) {
      const label = rowLabel(rows.length);
      const seatNumbers = [];

      for (let number = 1; number <= seatsPerRow; number += 1) {
        seatNumbers.push(number);
        seats.push({ rowLabel: label, seatNumber: number, tier: band.tier });
      }

      rows.push({ label, tier: band.tier, seatNumbers });
    }
  }

  const layout = {
    seatsPerRow,
    aislesAfterColumn,
    tiers: tierBands.map((band) => band.tier),
    rows,
  };

  return { layout, seats };
}

// The layout's own count, derived from the presentation structure rather than
// from the seat list, so verification can compare the two independently.
export function countSeatsInLayout(layout) {
  return layout.rows.reduce((total, row) => total + row.seatNumbers.length, 0);
}
