const crypto = require("crypto");
const razorpay = require("./razorpay.service");

// RazorpayX Payouts (money OUT to a customer's UPI ID). Used only for cash-on-delivery
// refunds: a COD order has no Razorpay payment, so the normal Payment Refund API can
// never be used for it. Same API key pair as Razorpay (test keys only, enforced by
// razorpay.service). Nothing here ever pretends a payout happened: when RazorpayX is
// off or unreachable the callers fall back to the manual UPI refund.
//
// Needs: RAZORPAYX_ENABLED=true, RAZORPAYX_ACCOUNT_NUMBER (your RazorpayX account),
// RAZORPAYX_WEBHOOK_SECRET (set on the RazorpayX webhook in the dashboard).

const isEnabled = () => String(process.env.RAZORPAYX_ENABLED || "").trim().toLowerCase() === "true";
const accountNumber = () => (process.env.RAZORPAYX_ACCOUNT_NUMBER || "").trim();
const isConfigured = () => isEnabled() && Boolean(accountNumber()) && razorpay.isConfigured();
const isWebhookConfigured = () => Boolean(process.env.RAZORPAYX_WEBHOOK_SECRET);

const verifyWebhookSignature = (rawBody, signature) => {
  const secret = process.env.RAZORPAYX_WEBHOOK_SECRET;
  if (!secret || !rawBody || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = Buffer.from(String(signature), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
};

// Is Payouts actually activated on this account? Asked of RazorpayX itself (a read-only
// list call), cached for a minute so the admin screen does not hammer it.
let cached = null;
const getStatus = async ({ force = false } = {}) => {
  if (!isEnabled()) return { enabled: false, configured: false, active: false, reason: "RAZORPAYX_ENABLED is not true." };
  if (!accountNumber() || !razorpay.isConfigured()) {
    return { enabled: true, configured: false, active: false, reason: "RazorpayX account number or API keys are missing." };
  }
  if (!force && cached && Date.now() - cached.at < 60 * 1000) return cached.value;

  let value;
  try {
    await razorpay.request("GET", `/payouts?account_number=${encodeURIComponent(accountNumber())}&count=1`);
    value = { enabled: true, configured: true, active: true };
  } catch (error) {
    value = {
      enabled: true,
      configured: true,
      active: false,
      reason: error.razorpayStatus ? `RazorpayX refused the check: ${error.message}` : "RazorpayX could not be reached.",
    };
  }
  cached = { at: Date.now(), value };
  return value;
};

const resetStatusCache = () => {
  cached = null;
};

const createContact = ({ name, email, phone, referenceId }) =>
  razorpay.request("POST", "/contacts", {
    name: String(name || "Customer").slice(0, 50),
    ...(email ? { email } : {}),
    ...(phone ? { contact: String(phone) } : {}),
    type: "customer",
    reference_id: referenceId,
  });

const createUpiFundAccount = ({ contactId, upiId }) =>
  razorpay.request("POST", "/fund_accounts", {
    contact_id: contactId,
    account_type: "vpa",
    vpa: { address: upiId },
  });

// The idempotency key makes a repeated call with the same key return the SAME payout
// instead of sending money twice, which is what makes retrying after a timeout safe.
const createPayout = ({ fundAccountId, amountRupees, referenceId, idempotencyKey, narration, notes }) =>
  razorpay.request(
    "POST",
    "/payouts",
    {
      account_number: accountNumber(),
      fund_account_id: fundAccountId,
      amount: razorpay.toPaise(amountRupees),
      currency: "INR",
      mode: "UPI",
      purpose: "refund",
      queue_if_low_balance: false,
      reference_id: referenceId,
      narration: String(narration || "KOVENIK refund").slice(0, 30),
      notes: notes || {},
    },
    { "X-Payout-Idempotency": idempotencyKey }
  );

const fetchPayout = (payoutId) => razorpay.request("GET", `/payouts/${encodeURIComponent(payoutId)}`);

module.exports = {
  isEnabled,
  isConfigured,
  isWebhookConfigured,
  verifyWebhookSignature,
  getStatus,
  resetStatusCache,
  createContact,
  createUpiFundAccount,
  createPayout,
  fetchPayout,
};
