import { request } from './client.js';

// The Module 5.3 endpoint, called and nothing more. The client does not decide
// whether a payment already happened — it sends the event id it was given and
// the server answers from what it has recorded.
//
// No `simulate` field is ever sent from here. The mock's controls exist for the
// verification pass and Phase 6.1's late-payment injection; a browser has no
// business asking a payment to fail.
export function confirmPayment({ bookingRef, paymentEventId }) {
  return request('/api/payments/confirm', {
    method: 'POST',
    body: { booking_ref: bookingRef, payment_event_id: paymentEventId },
  });
}
