const reviewModeration = require("../services/review-moderation.service");
const returnService = require("../services/return.service");
const returnAnalytics = require("../services/return-analytics.service");
const inventoryHistory = require("../services/inventory-history.service");
const exportService = require("../services/export.service");
const sessionService = require("../services/session.service");
const audit = require("../services/audit.service");
const { publicMessage } = require("../utils/public-error");

// Admin + Super Admin operations added in the admin-controls phase. The router
// (routes/admin.routes.js) has already authenticated the caller and checked the
// role; the extra role rules below are for the few actions that are Super
// Admin only.

const fail = (res, error, label) => {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(`${label}:`, error.message);

  return res.status(status).json({
    success: false,
    code: error.code || undefined,
    message: publicMessage(error, "Something went wrong. Please try again."),
  });
};

const handler = (label, work) => async (req, res) => {
  try {
    return await work(req, res);
  } catch (error) {
    // A CSV download that already started cannot be turned into JSON.
    if (res.headersSent) return undefined;
    return fail(res, error, label);
  }
};

const str = (value) => (typeof value === "string" ? value : "");

// ---- reviews ----------------------------------------------------------------

const listReviews = handler("Admin list reviews error", async (req, res) => {
  const data = await reviewModeration.listForAdmin({
    page: req.query.page,
    limit: req.query.limit,
    status: str(req.query.status),
    rating: req.query.rating,
    search: str(req.query.search),
    productSlug: str(req.query.product),
  });
  return res.status(200).json({ success: true, ...data });
});

const moderateReview = handler("Admin moderate review error", async (req, res) => {
  const result = await reviewModeration.moderate({
    reviewId: str(req.params.reviewId),
    action: str(req.body?.action),
    reason: req.body?.reason,
    actor: audit.actorFrom(req),
  });
  return res.status(200).json({ success: true, review: result });
});

// ---- returns ----------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = (res, id) => {
  if (UUID.test(str(id))) return true;
  res.status(400).json({ success: false, message: "Invalid return id." });
  return false;
};

const listReturns = handler("Admin list returns error", async (req, res) => {
  const data = await returnService.listForAdmin({
    page: req.query.page,
    limit: req.query.limit,
    status: str(req.query.status),
    search: str(req.query.search),
  });
  return res.status(200).json({ success: true, ...data });
});

const getReturn = handler("Admin get return error", async (req, res) => {
  if (!validId(res, req.params.id)) return undefined;
  const data = await returnService.getForAdmin(req.params.id);
  return res.status(200).json({ success: true, return: data });
});

const decideReturn = handler("Admin decide return error", async (req, res) => {
  if (!validId(res, req.params.id)) return undefined;
  const data = await returnService.decide({
    id: req.params.id,
    decision: str(req.body?.decision),
    reason: req.body?.reason,
    actor: audit.actorFrom(req),
  });
  return res.status(200).json({ success: true, return: data });
});

// Goods have arrived. Nothing is restocked or refunded yet: that follows the inspection.
const receiveReturn = handler("Admin receive return error", async (req, res) => {
  if (!validId(res, req.params.id)) return undefined;
  const data = await returnService.markReceived({
    id: req.params.id,
    note: req.body?.note,
    actor: audit.actorFrom(req),
  });
  return res.status(200).json({ success: true, return: data });
});

const shipReturn = handler("Admin ship return error", async (req, res) => {
  if (!validId(res, req.params.id)) return undefined;
  const data = await returnService.markShipped({
    id: req.params.id,
    trackingReference: str(req.body?.trackingReference),
    actor: audit.actorFrom(req),
  });
  return res.status(200).json({ success: true, return: data });
});

const inspectReturn = handler("Admin inspect return error", async (req, res) => {
  if (!validId(res, req.params.id)) return undefined;
  const data = await returnService.inspect({
    id: req.params.id,
    inspections: req.body?.inspections,
    actor: audit.actorFrom(req),
  });
  return res.status(200).json({ success: true, return: data });
});

// The amount is never read from the request: the server calculates it. Only an
// optional deduction (with a reason) and, for cash on delivery, the payout details.
const refundReturn = handler("Admin return refund error", async (req, res) => {
  if (!validId(res, req.params.id)) return undefined;
  const data = await returnService.processRefund({
    id: req.params.id,
    deduction: req.body?.deduction,
    deductionReason: req.body?.deductionReason,
    method: str(req.body?.method),
    reference: req.body?.reference,
    actor: audit.actorFrom(req),
  });
  return res.status(200).json({ success: true, return: data });
});

const returnOptions = handler("Admin return options error", async (req, res) =>
  res.status(200).json({ success: true, ...returnService.options() })
);

const returnsAnalytics = handler("Admin returns analytics error", async (req, res) => {
  const data = await returnAnalytics.getReturnAnalytics({
    from: str(req.query.from) || undefined,
    to: str(req.query.to) || undefined,
    productId: str(req.query.productId),
  });
  return res.status(200).json({ success: true, data });
});

const retryReturnRefund = handler("Admin retry return refund error", async (req, res) => {
  if (!validId(res, req.params.id)) return undefined;
  const data = await returnService.retryRefund({
    id: req.params.id,
    actor: audit.actorFrom(req),
  });
  return res.status(200).json({ success: true, return: data });
});

// ---- inventory history ----------------------------------------------------------

const listInventoryMovements = handler("Admin inventory history error", async (req, res) => {
  const data = await inventoryHistory.list({
    page: req.query.page,
    limit: req.query.limit,
    productId: str(req.query.productId),
    variantId: str(req.query.variantId),
    source: str(req.query.source),
    from: str(req.query.from),
    to: str(req.query.to),
    search: str(req.query.search),
  });
  return res.status(200).json({ success: true, ...data });
});

// ---- exports ------------------------------------------------------------------

const exportOrders = handler("Admin orders export error", async (req, res) => {
  const wantsCustomer = req.query.includeCustomer === "1" || req.query.includeCustomer === "true";

  // Customer details leave the system only through a Super Admin.
  if (wantsCustomer && req.user.role !== "superadmin") {
    return res.status(403).json({
      success: false,
      message: "Only a Super Admin can export customer details.",
    });
  }

  return exportService.streamOrders({
    res,
    query: req.query,
    includeCustomer: wantsCustomer,
    actor: audit.actorFrom(req),
  });
});

const exportSalesSummary = handler("Super admin sales summary export error", async (req, res) =>
  exportService.streamSalesSummary({ res, query: req.query, actor: audit.actorFrom(req) })
);

// ---- own account security ----------------------------------------------------------

const getSecurity = handler("Admin security overview error", async (req, res) => {
  const data = await sessionService.listLogins(req.user.id, req.query.limit);
  return res.status(200).json({ success: true, ...data });
});

const signOutEverywhere = handler("Admin sign-out-everywhere error", async (req, res) => {
  const result = await sessionService.revokeAll(req.user.id);

  if (!result.revoked) {
    return res.status(503).json({
      success: false,
      message:
        result.error === "not_installed"
          ? "Sign-out-everywhere is not available yet. The database update has not been applied."
          : "Could not sign out your other sessions. Please try again.",
    });
  }

  await audit.record({
    req,
    action: "security.sign_out_everywhere",
    resourceType: "user",
    resourceId: req.user.id,
  });

  return res.status(200).json({
    success: true,
    message: "All your sessions, including this one, have been signed out.",
  });
});

module.exports = {
  listReviews,
  moderateReview,
  listReturns,
  getReturn,
  decideReturn,
  receiveReturn,
  shipReturn,
  inspectReturn,
  refundReturn,
  returnOptions,
  returnsAnalytics,
  retryReturnRefund,
  listInventoryMovements,
  exportOrders,
  exportSalesSummary,
  getSecurity,
  signOutEverywhere,
};
