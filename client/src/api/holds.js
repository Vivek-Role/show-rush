import { request } from './client.js';

// The Module 4.2 endpoints, called and nothing more. The client never decides
// whether a hold is still valid — it asks, and the server's TTL is the answer.

export function holdSeats({ showId, seatIds }) {
  return request(`/api/shows/${showId}/holds`, {
    method: 'POST',
    body: { seat_ids: seatIds },
  });
}

export function releaseSeats({ showId, seatIds }) {
  return request(`/api/shows/${showId}/holds`, {
    method: 'DELETE',
    body: { seat_ids: seatIds },
  });
}

// Only ever the caller's own holds, and only for seats it already knows about.
// There is no "what is held on this show" call to make: the server does not
// offer one, by design.
export function fetchHoldTtl({ showId, seatIds }) {
  const query = new URLSearchParams({ seat_ids: seatIds.join(',') });
  return request(`/api/shows/${showId}/holds/ttl?${query}`);
}
