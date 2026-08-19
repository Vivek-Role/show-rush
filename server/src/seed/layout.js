// One generator, two outputs: the presentation layout stored on screens.layout,
// and the flat seat list inserted into seats. They come from the same pass, so
// they cannot drift.
//
// seats is authoritative for which seats exist and every foreign key points at
// it. The layout describes only how to draw them — rows, columns, tiers, and
// where the aisles fall.

function rowLabel(index) {
  // Thirteen rows at most in this build, so a single letter is enough.
  return String.fromCharCode(65 + index);
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
