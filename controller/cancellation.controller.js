const cancellationService = require("../services/cancellation.service");
const audit = require("../services/audit.service");
const { publicMessage } = require("../utils/public-error");

// Cancellation endpoints (customer and admin). Who may cancel what, and the
// refund, are decided in services/cancellation.service; nothing here trusts an
// amount or an eligibility flag from the browser.

const fail = (res, error, label) => {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(`${label}:`, error.message);
  return res.status(status).json({
    success: false,
    code: error.code || undefined,
    message: publicMessage(error, "Something went wrong. Please try again."),
  });
};

const str = (value) => (typeof value === "string" ? value : "");

// ---- customer -----------------------------------------------------------------------

const options = async (req, res) => {
  try {
    const data = await cancellationService.getOptions({ orderId: str(req.params.orderId), ownerUserId: req.user.id, isAdmin: false });
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return fail(res, error, "Cancel options error");
  }
};

const preview = async (req, res) => {
  try {
    const data = await cancellationService.preview({
      orderId: str(req.params.orderId),
      ownerUserId: req.user.id,
      isAdmin: false,
      items: req.body?.items,
    });
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return fail(res, error, "Cancel preview error");
  }
};

const cancelMine = async (req, res) => {
  try {
    const result = await cancellationService.cancel({
      orderId: str(req.params.orderId),
      actor: audit.actorFrom(req),
      isAdmin: false,
      ownerUserId: req.user.id,
      reasonCode: str(req.body?.reasonCode),
      note: req.body?.note,
      items: req.body?.items,
    });

    // Customers see "cancelled" and a refund promise, never internal refund states.
    const refundLine =
      !result.legacy && result.refundAmount > 0
        ? ` A refund of ₹${Number(result.refundAmount).toFixed(2)} will be sent to your original payment method.`
        : "";
    return res.status(200).json({
      success: true,
      message: (result.wholeOrder ? "Your order has been cancelled." : "The selected items have been cancelled.") + refundLine,
      order: { id: str(req.params.orderId), status: result.status },
      // (the original whole-order cancel says nothing about refunds)
      ...(result.legacy ? {} : { cancellation: { id: result.id, wholeOrder: result.wholeOrder, refundAmount: result.refundAmount } }),
    });
  } catch (error) {
    return fail(res, error, "Cancel order error");
  }
};

// ---- admin ---------------------------------------------------------------------------

const adminOptions = async (req, res) => {
  try {
    const data = await cancellationService.getOptions({ orderId: str(req.params.orderId), ownerUserId: null, isAdmin: true });
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return fail(res, error, "Admin cancel options error");
  }
};

const adminPreview = async (req, res) => {
  try {
    const data = await cancellationService.preview({ orderId: str(req.params.orderId), ownerUserId: null, isAdmin: true, items: req.body?.items });
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return fail(res, error, "Admin cancel preview error");
  }
};

const adminCancel = async (req, res) => {
  try {
    const result = await cancellationService.cancel({
      orderId: str(req.params.orderId),
      actor: audit.actorFrom(req),
      isAdmin: true,
      ownerUserId: null,
      reasonCode: str(req.body?.reasonCode),
      note: req.body?.note,
      items: req.body?.items,
    });
    return res.status(200).json({
      success: true,
      message: result.wholeOrder ? "Order cancelled." : "Selected items cancelled.",
      cancellation: result,
    });
  } catch (error) {
    return fail(res, error, "Admin cancel error");
  }
};

module.exports = { options, preview, cancelMine, adminOptions, adminPreview, adminCancel };
