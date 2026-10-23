const crypto = require("crypto");

// Razorpay REST access using the built-in fetch + crypto (no extra dependency).
// Only TEST credentials (rzp_test_*) are accepted; live keys are refused.

const API_BASE = "https://api.razorpay.com/v1";

const getCredentials = () => {
  const keyId = (process.env.RAZORPAY_KEY_ID || "").trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || "").trim();

  if (!keyId || !keySecret) {
    throw new Error("Online payments are not configured.");
  }

  if (!keyId.startsWith("rzp_test_")) {
    throw new Error("Only Razorpay test keys are allowed in this phase.");
  }

  return { keyId, keySecret };
};

const isConfigured = () => {
  try {
    getCredentials();
    return true;
  } catch (_) {
    return false;
  }
};

const request = async (method, path, body) => {
  const { keyId, keySecret } = getCredentials();

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const reason = data?.error?.description || `Razorpay error ${response.status}`;
    const error = new Error(reason);
    error.razorpayStatus = response.status;
    // Everything Razorpay returned about the failure, plus what we sent. Never
    // includes credentials (they live only in the Authorization header).
    error.razorpay = {
      httpStatus: response.status,
      requestId: response.headers?.get?.("x-razorpay-request-id") || null,
      code: data?.error?.code ?? null,
      description: data?.error?.description ?? null,
      field: data?.error?.field ?? null,
      reason: data?.error?.reason ?? null,
      source: data?.error?.source ?? null,
      step: data?.error?.step ?? null,
      metadata: data?.error?.metadata ?? null,
      request: { method, path, body: body ?? null },
    };
    throw error;
  }

  return data;
};

// Razorpay pays refunds out of the account balance, which is net of fees (and
// in test mode only grows with test payments). When it is lower than the refund,
// Razorpay can answer with the vague "invalid request sent" (BAD_REQUEST_ERROR,
// reason/source/step "NA"). Best-effort: returns null if it cannot be read.
const fetchBalancePaise = async () => {
  try {
    const data = await request("GET", "/balance");
    const balance = Number(data?.balance);
    return Number.isFinite(balance) ? balance : null;
  } catch (_) {
    return null;
  }
};

// Refunds already created for a payment (read-only). Used to make a retry
// idempotent: if a refund exists, adopt it instead of creating another.
// Returns null when it cannot be read.
const fetchPaymentRefunds = async (paymentId) => {
  try {
    const data = await request(
      "GET",
      `/payments/${encodeURIComponent(paymentId)}/refunds`
    );
    return Array.isArray(data?.items) ? data.items : [];
  } catch (_) {
    return null;
  }
};

// One-line, secret-free JSON for server logs.
const describeError = (error) =>
  JSON.stringify(
    error?.razorpay ?? {
      httpStatus: error?.razorpayStatus ?? null,
      description: error?.message ?? String(error),
    }
  );

const toPaise = (rupees) => Math.round(Number(rupees) * 100);

const createOrder = ({ amountRupees, receipt, notes }) =>
  request("POST", "/orders", {
    amount: toPaise(amountRupees),
    currency: "INR",
    receipt,
    notes,
  });

const fetchOrderPayments = async (razorpayOrderId) => {
  const data = await request(
    "GET",
    `/orders/${encodeURIComponent(razorpayOrderId)}/payments`
  );
  return Array.isArray(data?.items) ? data.items : [];
};

const refundPayment = (paymentId, amountRupees) =>
  request("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, {
    amount: toPaise(amountRupees),
  });

// Razorpay signs "<razorpay_order_id>|<razorpay_payment_id>" with the key secret.
const verifySignature = ({ razorpayOrderId, razorpayPaymentId, signature }) => {
  if (!razorpayOrderId || !razorpayPaymentId || !signature) return false;

  const { keySecret } = getCredentials();
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");

  const given = Buffer.from(String(signature), "utf8");
  const wanted = Buffer.from(expected, "utf8");

  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
};

module.exports = {
  getCredentials,
  isConfigured,
  toPaise,
  createOrder,
  fetchOrderPayments,
  refundPayment,
  describeError,
  fetchBalancePaise,
  fetchPaymentRefunds,
  verifySignature,
};
