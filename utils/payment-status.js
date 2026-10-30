// Payment status words kept on orders.payment_status, and what they mean.
//
//   Pending / Failed       nothing collected
//   Paid                   money collected, nothing (confirmed) paid back
//   Partially Refunded     money collected, part of it confirmed paid back
//   Refund Pending         the order is cancelled and its refund is not confirmed yet
//   Refunded               everything that was collected is confirmed paid back
//
// "Money is still held" (Paid or Partially Refunded) is what every later
// cancellation / return refund needs to check, so it lives here once.

const PAID = "Paid";
const PARTIALLY_REFUNDED = "Partially Refunded";
const REFUND_PENDING = "Refund Pending";
const REFUNDED = "Refunded";

const lc = (value) => String(value || "").trim().toLowerCase();

const HELD = [PAID, PARTIALLY_REFUNDED].map(lc);
const COLLECTED = [PAID, PARTIALLY_REFUNDED, REFUND_PENDING, REFUNDED].map(lc);

// Money was collected and some of it is still with us: more can be refunded.
const isHeld = (status) => HELD.includes(lc(status));

// Money was collected at some point (stock was taken, the order was real).
const isCollected = (status) => COLLECTED.includes(lc(status));

module.exports = { PAID, PARTIALLY_REFUNDED, REFUND_PENDING, REFUNDED, isHeld, isCollected, HELD, COLLECTED };
