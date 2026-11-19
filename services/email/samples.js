// Sample data for every template. Used by the preview script and the tests only; nothing here is
// ever sent to a customer.
const order = {
  orderId: "0b8f6a52-2c63-4c0e-9d52-1f3b1a7e9c11",
  orderNumber: "KOV-240915-1042",
  placedAt: "2026-11-09T09:30:00Z",
  paymentMethod: "online",
  lines: [
    { name: "Oversized Graphic Tee", size: "L", color: "Black", quantity: 2, unitPrice: 1299 },
    { name: "Essential Cargo Pants", size: "32", color: "Olive", quantity: 1, unitPrice: 2499 },
  ],
  subtotal: 5097,
  discount: 250,
  couponCode: "WELCOME250",
  shipping: 0,
  tax: 243,
  total: 5090,
  shipName: "Asha Rao",
  shipPhone: "9876543210",
  shipAddress: "12 MG Road, Indiranagar",
  shipCity: "Bengaluru",
  shipState: "Karnataka",
  shipPincode: "560038",
};

const base = { name: "Asha", orderId: order.orderId, orderNumber: order.orderNumber };

const SAMPLES = {
  account_otp: { name: "Asha", code: "482913", purpose: "email_verification" },
  newsletter_confirm: { confirmUrl: require("./layout").link.newsletterConfirm("A".repeat(43)), hours: 48 },
  welcome: { name: "Asha" },
  password_changed: { name: "Asha", changedAt: "2026-11-09T10:00:00Z" },
  support_received: { name: "Asha", subject: "Where is my order?", orderNumber: order.orderNumber },
  support_inbound: { name: "Asha Rao", email: "asha@example.com", subject: "Where is my order?", orderNumber: order.orderNumber, message: "Hi, my order was supposed to arrive yesterday.\nCould you check the status?" },
  order_confirmation: { name: "Asha", ...order },
  order_shipped: { ...base, carrier: "Delhivery", trackingNumber: "DL123456789" },
  order_delivered: base,
  cancellation_confirmed: { ...base, whole: true, items: "Oversized Graphic Tee x 2", reason: "Ordered by mistake", refundAmount: 2598 },
  payment_failed: { ...base, amount: 5090 },
  refund_initiated: { ...base, amount: 2598 },
  refund_completed: { ...base, amount: 2598, method: "UPI", reference: "rfnd_Ab12Cd34" },
  refund_failed: { ...base, amount: 2598 },
  return_submitted: { ...base, items: "Essential Cargo Pants (32)" },
  return_approved: { ...base, items: "Essential Cargo Pants (32)" },
  return_rejected: { ...base, reason: "The item shows signs of wear." },
  return_received: base,
  return_inspected: { ...base, refundable: true, note: "Item is in good condition." },
  return_refund_processing: { ...base, amount: 2499 },
  return_refund_completed: { ...base, amount: 2499, method: "UPI", reference: "rfnd_Ef56Gh78" },
  return_refund_failed: { ...base, amount: 2499 },
  membership_activated: { name: "Asha", planName: "KOVENIK MEMBER", amount: 199, startDate: "2026-11-09T10:00:00Z", endDate: "2027-11-09T10:00:00Z" },
  membership_renewed: { name: "Asha", planName: "KOVENIK MEMBER", amount: 199, startDate: "2027-11-09T10:00:00Z", endDate: "2028-11-08T10:00:00Z" },
  membership_expiring: { name: "Asha", planName: "KOVENIK MEMBER", endDate: "2027-11-09T10:00:00Z" },
  membership_expired: { name: "Asha", endDate: "2027-11-09T10:00:00Z" },
  membership_payment_failed: { name: "Asha", planName: "KOVENIK MEMBER", amount: 199 },
};

module.exports = { SAMPLES };
