const membership = require("../services/membership.service");
const { publicMessage } = require("../utils/public-error");

const isText = (value, max = 200) => typeof value === "string" && value.length > 0 && value.length <= max;

// Errors raised with a statusCode are written for the customer/admin; anything else is masked.
const fail = (res, error, fallback) => {
  const status = error.statusCode || 400;
  if (status >= 500 || !error.statusCode) console.error("Membership error:", error.message);
  return res.status(status).json({
    success: false,
    message: error.statusCode ? error.message : publicMessage(error, fallback),
  });
};

const wrap = (fallback, handler) => async (req, res) => {
  try {
    return res.status(200).json({ success: true, ...(await handler(req, res)) });
  } catch (error) {
    return fail(res, error, fallback);
  }
};

// ---------- public / customer ----------

const getPlans = wrap("Unable to load membership plans.", async () => ({ plans: await membership.getPublicPlans() }));

const getMy = wrap("Unable to load your membership.", (req) => membership.getMyMembership(req.user.id));

const getMyPricing = wrap("Unable to load member prices.", (req) => {
  const ids = typeof req.query.ids === "string" ? req.query.ids.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100) : null;
  return membership.getMyPricing(req.user.id, ids);
});

const getPreviewPricing = wrap("Unable to load membership prices.", (req) => {
  const ids = typeof req.query.ids === "string" ? req.query.ids.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100) : null;
  return membership.getPreviewPricing(ids);
});

const purchase = wrap("Unable to start the membership payment.", async (req) => {
  if (!isText(req.body?.planId)) throw Object.assign(new Error("planId is required."), { statusCode: 400 });
  return { payment: await membership.startPurchase({ userId: req.user.id, planId: req.body.planId }) };
});

const verify = wrap("Payment verification failed.", async (req) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  if (![orderId, paymentId, signature].every((v) => isText(v))) {
    throw Object.assign(new Error("Incomplete payment details."), { statusCode: 400 });
  }
  const result = await membership.verifyPurchase({
    userId: req.user.id,
    razorpayOrderId: orderId,
    razorpayPaymentId: paymentId,
    signature,
  });
  return { outcome: result.outcome, startDate: result.startDate, endDate: result.endDate };
});

const failed = wrap("Unable to record the payment result.", async (req) => {
  if (!isText(req.body?.razorpay_order_id)) throw Object.assign(new Error("razorpay_order_id is required."), { statusCode: 400 });
  return membership.markFailed({ userId: req.user.id, razorpayOrderId: req.body.razorpay_order_id });
});

const sync = wrap("Unable to check the payment.", async (req) => {
  if (!isText(req.body?.razorpay_order_id)) throw Object.assign(new Error("razorpay_order_id is required."), { statusCode: 400 });
  return membership.syncPurchase({ userId: req.user.id, razorpayOrderId: req.body.razorpay_order_id });
});

const birthday = wrap("Unable to save your birth date.", (req) => membership.setBirthday(req.user.id, req.body?.birthday));

// ---------- admin ----------

const adminPlans = wrap("Unable to load plans.", async () => ({
  plans: await membership.adminListPlans(),
  settings: await membership.getSettings(await require("../config/sql").poolPromise),
}));

const adminCreatePlan = wrap("Unable to create the plan.", async (req) => ({
  plan: await membership.adminSavePlan({ input: req.body || {}, req }),
}));

const adminUpdatePlan = wrap("Unable to update the plan.", async (req) => ({
  plan: await membership.adminSavePlan({ planId: req.params.id, input: req.body || {}, req }),
}));

const adminPurchases = wrap("Unable to load purchases.", (req) => membership.adminListPurchases(req.query));

const adminStatus = wrap("Unable to change the membership.", async (req) => ({
  result: await membership.adminChangeStatus({
    subscriptionId: req.params.id,
    userId: req.body?.userId,
    planId: req.body?.planId,
    action: req.body?.action,
    reason: req.body?.reason,
    req,
  }),
}));

const adminRules = wrap("Unable to load product rules.", async (req) => ({
  products: await membership.adminListProductRules(req.params.id),
}));

const adminSetRule = wrap("Unable to save the product rule.", async (req) => ({
  rule: await membership.adminSetProductRule({
    planId: req.params.id,
    productId: req.params.productId,
    eligible: req.body?.eligible,
    memberPrice: req.body?.memberPrice,
    req,
  }),
}));

const adminSettings = wrap("Unable to save settings.", async (req) => ({
  settings: await membership.updateSettings(req.body || {}, req),
}));

module.exports = {
  getPlans,
  getMy,
  getMyPricing,
  getPreviewPricing,
  purchase,
  verify,
  failed,
  sync,
  birthday,
  adminPlans,
  adminCreatePlan,
  adminUpdatePlan,
  adminPurchases,
  adminStatus,
  adminRules,
  adminSetRule,
  adminSettings,
};
