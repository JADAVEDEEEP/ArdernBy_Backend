const paymentService = require("../services/payment.service");
const razorpay = require("../services/razorpay.service");
const refundRunner = require("../services/refund-runner.service");
const returnService = require("../services/return.service");
const cancellationService = require("../services/cancellation.service");
const { publicMessage } = require("../utils/public-error");

const isText = (value) => typeof value === "string" && value.length > 0 && value.length <= 200;

const fail = (res, status, error, fallback) => {
  console.error("Payment error:", error.message);

  return res.status(status).json({
    success: false,
    message: publicMessage(error, fallback),
  });
};

const createRazorpayOrder = async (req, res) => {
  try {
    const { orderId } = req.body || {};

    if (!isText(orderId)) {
      return res.status(400).json({ success: false, message: "orderId is required." });
    }

    const payment = await paymentService.createPaymentOrder({
      userId: req.user.id,
      orderId,
    });

    return res.status(201).json({ success: true, payment });
  } catch (error) {
    return fail(res, 400, error, "Unable to start payment.");
  }
};

const verifyRazorpayPayment = async (req, res) => {
  try {
    const {
      orderId,
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: razorpayPaymentId,
      razorpay_signature: signature,
    } = req.body || {};

    if (
      ![orderId, razorpayOrderId, razorpayPaymentId, signature].every(isText)
    ) {
      return res.status(400).json({
        success: false,
        message: "Incomplete payment details.",
      });
    }

    const result = await paymentService.verifyPayment({
      userId: req.user.id,
      orderId,
      razorpayOrderId,
      razorpayPaymentId,
      signature,
    });

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return fail(res, 400, error, "Payment verification failed.");
  }
};

const reportPaymentFailure = async (req, res) => {
  try {
    const { orderId } = req.body || {};

    if (!isText(orderId)) {
      return res.status(400).json({ success: false, message: "orderId is required." });
    }

    const result = await paymentService.markFailed({
      userId: req.user.id,
      orderId,
    });

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return fail(res, 400, error, "Unable to record payment result.");
  }
};

const syncRazorpayPayment = async (req, res) => {
  try {
    const { orderId } = req.body || {};

    if (!isText(orderId)) {
      return res.status(400).json({ success: false, message: "orderId is required." });
    }

    const result = await paymentService.syncPayment({
      userId: req.user.id,
      orderId,
    });

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return fail(res, 400, error, "Unable to check payment status.");
  }
};

// POST /api/payments/razorpay/webhook (public: authenticated by signature only).
const razorpayWebhook = async (req, res) => {
  if (!razorpay.isWebhookConfigured()) {
    console.error("Razorpay webhook received but RAZORPAY_WEBHOOK_SECRET is not set.");
    return res.status(503).json({ success: false, message: "Webhook is not configured." });
  }

  const signature = req.get("x-razorpay-signature");

  if (!razorpay.verifyWebhookSignature(req.rawBody, signature)) {
    console.warn("Razorpay webhook rejected: bad signature.");
    return res.status(400).json({ success: false, message: "Invalid signature." });
  }

  const event = req.body || {};
  const eventId = req.get("x-razorpay-event-id") || "n/a";

  // Refund results from Razorpay. Matched to OUR refunds by receipt key / refund id,
  // moved forward only (a completed refund never goes back), and repeated deliveries
  // change nothing (the e-mails are deduplicated too).
  if (event.event === "refund.processed" || event.event === "refund.failed") {
    const refund = event.payload?.refund?.entity;
    try {
      const outcome = await refundRunner.applyRefundEvent({
        refundId: refund?.id,
        receipt: refund?.receipt,
        status: event.event === "refund.failed" ? "failed" : refund?.status || "processed",
      });
      if (outcome.matched && outcome.changed) {
        if (outcome.table === "order_cancellations") await cancellationService.afterRefundChange(outcome.id);
        if (outcome.table === "return_requests") await returnService.afterRefundChange(outcome.id);
      }
      console.log("Razorpay webhook | event:", eventId, "|", event.event, "| refund:", refund?.id, "|", outcome.matched ? (outcome.changed ? "updated" : "already up to date") : outcome.reason);
      return res.status(200).json({ success: true, matched: Boolean(outcome.matched), changed: Boolean(outcome.changed) });
    } catch (error) {
      console.error("Razorpay refund webhook failed | event:", eventId, "|", error.message);
      return res.status(500).json({ success: false, message: "Could not process the event." });
    }
  }

  if (event.event !== "payment.captured" && event.event !== "order.paid") {
    // Valid and signed, just not something that changes an order here.
    return res.status(200).json({ success: true, ignored: event.event || null });
  }

  const payment = event.payload?.payment?.entity;

  try {
    const args = {
      razorpayOrderId: payment?.order_id,
      paymentId: payment?.id,
      amountPaise: payment?.amount,
    };
    let result = await paymentService.settleWebhookPayment(args);

    // Not a shop order: it may be a membership purchase (same Razorpay account and webhook).
    if (result.reason === "unknown_order") {
      result = await require("../services/membership.service").settleWebhookPayment(args);
    }

    console.log(
      "Razorpay webhook | event:", eventId,
      "|", event.event,
      "| order:", payment?.order_id,
      "|", result.outcome || result.reason
    );

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    // A 5xx makes Razorpay retry; settling is idempotent, so that is safe.
    console.error("Razorpay webhook failed | event:", eventId, "|", error.message);
    return res.status(500).json({ success: false, message: "Could not process the event." });
  }
};

module.exports = {
  razorpayWebhook,
  createRazorpayOrder,
  verifyRazorpayPayment,
  reportPaymentFailure,
  syncRazorpayPayment,
};
