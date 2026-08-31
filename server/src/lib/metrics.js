// Fixed-bucket duration histograms. No dependency, bounded memory.
//
// Phase 9 M2. Every number this repository publishes so far was measured by k6
// from outside the process; nothing inside the server could say where the time
// went. This is the inside view.
//
// Buckets rather than a retained sample array, and that is the whole design
// decision. Keeping every duration to sort later is an unbounded allocation on
// exactly the path that is supposed to survive load — 600 holds a second for a
// minute is 36,000 numbers per route, growing until the process dies. A
// histogram costs one array of counters per route forever.
//
// The price is resolution: a percentile is the upper bound of the bucket the
// p-th sample falls into, not the sample itself. That is stated wherever the
// numbers are reported, and it is why count, min, max and mean — which are
// exact — are reported alongside.

// Milliseconds. Dense where the booking and hold paths actually live (Phase 7
// measured hold latency from 45 ms to 198 ms average) and coarse out in the
// tail, where the only question is "how bad".
const BUCKET_BOUNDS = [
  1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120, 200, 300, 500, 800, 1200, 2000, 5000,
];

/** route key -> { counts, count, sum, min, max } */
const histograms = new Map();

function emptyHistogram() {
  return {
    // One extra slot for everything above the last bound.
    counts: new Array(BUCKET_BOUNDS.length + 1).fill(0),
    count: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: 0,
  };
}

function bucketFor(ms) {
  for (let i = 0; i < BUCKET_BOUNDS.length; i += 1) {
    if (ms <= BUCKET_BOUNDS[i]) return i;
  }
  return BUCKET_BOUNDS.length;
}

/**
 * Record one observation. `key` is a route pattern, never a URL — the cardinality
 * of this Map is the number of routes in the application, and it must stay that
 * way.
 */
export function record(key, ms) {
  if (!Number.isFinite(ms) || ms < 0) return;

  let histogram = histograms.get(key);
  if (!histogram) {
    histogram = emptyHistogram();
    histograms.set(key, histogram);
  }

  histogram.counts[bucketFor(ms)] += 1;
  histogram.count += 1;
  histogram.sum += ms;
  if (ms < histogram.min) histogram.min = ms;
  if (ms > histogram.max) histogram.max = ms;
}

/**
 * The upper bound of the bucket holding the p-th observation.
 *
 * Deliberately not interpolated. Interpolating between bucket bounds would
 * produce a number with more decimal places than the data has resolution, and
 * this file would then be inventing precision — which is the one thing
 * CLAUDE.md §6 rules out.
 *
 * Observations past the last bound report the observed max, because there is no
 * upper bound to report and max is a real measurement.
 */
function percentile(histogram, p) {
  if (histogram.count === 0) return null;

  const target = Math.ceil((p / 100) * histogram.count);
  let seen = 0;

  for (let i = 0; i < histogram.counts.length; i += 1) {
    seen += histogram.counts[i];
    if (seen >= target) {
      return i < BUCKET_BOUNDS.length ? BUCKET_BOUNDS[i] : round(histogram.max);
    }
  }

  return round(histogram.max);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Every route's summary. Percentiles are bucket upper bounds; count, min, max
 * and mean are exact.
 */
export function snapshot() {
  const routes = {};

  for (const [key, histogram] of histograms) {
    routes[key] = {
      count: histogram.count,
      min_ms: histogram.count === 0 ? null : round(histogram.min),
      max_ms: round(histogram.max),
      mean_ms: histogram.count === 0 ? null : round(histogram.sum / histogram.count),
      p50_ms: percentile(histogram, 50),
      p95_ms: percentile(histogram, 95),
      p99_ms: percentile(histogram, 99),
    };
  }

  return {
    unit: 'milliseconds',
    percentile_method: 'bucket upper bound; count/min/max/mean are exact',
    bucket_bounds_ms: BUCKET_BOUNDS,
    routes,
  };
}

export function resetMetrics() {
  histograms.clear();
}
