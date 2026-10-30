const returnService = require("../services/return.service");
const audit = require("../services/audit.service");
const { publicMessage } = require("../utils/public-error");

// Customer side of returns. The caller is always the logged-in customer: the
// user id comes from the token, never from the request. Refund amounts are never
// accepted from the browser; the server calculates them.

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requestReturn = async (req, res) => {
  try {
    const { orderId, reasonCode, description, items } = req.body || {};
    const data = await returnService.createRequest({
      userId: req.user.id,
      orderId: str(orderId),
      reasonCode: str(reasonCode),
      description,
      items,
      actor: audit.actorFrom(req),
    });
    return res.status(201).json({ success: true, return: data });
  } catch (error) {
    return fail(res, error, "Request return error");
  }
};

const previewReturn = async (req, res) => {
  try {
    const { orderId, items } = req.body || {};
    const data = await returnService.preview({ userId: req.user.id, orderId: str(orderId), items });
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return fail(res, error, "Preview return error");
  }
};

const getMyReturn = async (req, res) => {
  try {
    const data = await returnService.getForCustomer({
      userId: req.user.id,
      orderId: String(req.params.orderId || "").slice(0, 64),
    });
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return fail(res, error, "Get my return error");
  }
};

// "I have sent the items" (optional tracking reference).
const shipMyReturn = async (req, res) => {
  try {
    if (!UUID.test(str(req.params.id))) {
      return res.status(400).json({ success: false, message: "Invalid return id." });
    }
    const data = await returnService.markShipped({
      id: req.params.id,
      trackingReference: str(req.body?.trackingReference),
      actor: audit.actorFrom(req),
      ownerUserId: req.user.id,
    });
    return res.status(200).json({ success: true, return: { id: data.id, status: data.status, trackingReference: data.trackingReference } });
  } catch (error) {
    return fail(res, error, "Ship my return error");
  }
};

module.exports = { requestReturn, previewReturn, getMyReturn, shipMyReturn };
