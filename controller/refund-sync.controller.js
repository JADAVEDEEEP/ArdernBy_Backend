const refundSync = require("../services/refund-sync.service");
const audit = require("../services/audit.service");
const { publicMessage } = require("../utils/public-error");

const fail = (res, error, label) => {
  console.error(label + ":", error.code || error.message);
  return res.status(error.statusCode || 500).json({ success: false, message: publicMessage(error) });
};

const summarise = (outcome) => {
  if (outcome.checked === 0) return "No refund is waiting for a check.";
  const done = outcome.results.filter((r) => r.changed && r.status === "completed").length;
  const failed = outcome.results.filter((r) => r.changed && r.status === "failed").length;
  const unreadable = outcome.results.filter((r) => r.checked === false && r.reason === "razorpay_unreadable").length;
  if (unreadable > 0 && done === 0) return "Razorpay could not be reached. Nothing was changed; try again in a minute.";
  if (done > 0) return `${done} refund${done === 1 ? "" : "s"} confirmed by Razorpay and recorded.`;
  if (failed > 0) return `Razorpay reports ${failed} refund${failed === 1 ? "" : "s"} as failed. Use Retry refund.`;
  return "Razorpay has not finished this refund yet. Nothing was changed; it is checked again automatically.";
};

// GET /api/orders/admin/:orderId/refunds
const history = async (req, res) => {
  try {
    const data = await refundSync.historyForOrder(req.params.orderId);
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return fail(res, error, "Refund history error");
  }
};

// POST /api/orders/admin/:orderId/refunds/check  (reads Razorpay only; never creates a refund)
const check = async (req, res) => {
  try {
    const outcome = await refundSync.checkOrder({ orderId: req.params.orderId, actor: audit.actorFrom(req) });
    return res.status(200).json({ success: true, message: summarise(outcome), ...outcome });
  } catch (error) {
    return fail(res, error, "Refund check error");
  }
};

// POST /api/admin/returns/:id/refund-check
const checkReturn = async (req, res) => {
  try {
    const outcome = await refundSync.checkReturn({ id: req.params.id, actor: audit.actorFrom(req) });
    return res.status(200).json({ success: true, message: summarise(outcome), ...outcome });
  } catch (error) {
    return fail(res, error, "Return refund check error");
  }
};

module.exports = { history, check, checkReturn };
