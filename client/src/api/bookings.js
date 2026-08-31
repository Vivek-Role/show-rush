import { request } from './client.js';

// The Phase 2 endpoint, called and nothing more. The client does not re-check
// availability, does not decide what a seat costs, and does not pre-empt the
// 409 — the database is the only participant that sees every transaction, so
// it is the only one that can decide.
export function createBooking({ showId, seatIds }) {
  return request('/api/bookings', {
    method: 'POST',
    body: { show_id: showId, seat_ids: seatIds },
  });
}
