const paymentService = require("../services/payment.service");
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

module.exports = {
  createRazorpayOrder,
  verifyRazorpayPayment,
  reportPaymentFailure,
  syncRazorpayPayment,
};
