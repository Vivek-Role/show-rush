import { closePool } from './db/pool.js';
import { runSweep } from './services/reconcileService.js';

// Phase 6.2 — the sweep, run once, from the command line.
//
// The same runSweep() the in-process interval calls. There is deliberately no
// second implementation: a reconciliation job whose manual and scheduled forms
// could drift is a job nobody can reason about.
//
// This exists because RECONCILE_INTERVAL_SECONDS=0 disables the interval, and
// because waiting a minute to observe a sweep makes verification slower than it
// needs to be. Redis is never connected here — the sweep does not touch it.

try {
  const result = await runSweep();
  console.log(
    `scanned ${result.scanned}, cancelled ${result.cancelled}, seats released ${result.seatsReleased}`,
  );

  for (const booking of result.expired) {
    console.log(`  booking ${booking.bookingId} (show ${booking.showId}): ${booking.seatIds.join(', ')}`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
