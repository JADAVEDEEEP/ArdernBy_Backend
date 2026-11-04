const crypto = require("crypto");
const { poolPromise } = require("../config/sql");
const razorpay = require("./razorpay.service");
const couponService = require("./coupon.service");
const audit = require("./audit.service");
const { decidePurchase, addDays } = require("../utils/membership-policy");
const {
  DEFAULT_MAX_TOTAL_DISCOUNT_PERCENT,
  memberUnitPrice,
  capCouponDiscount,
} = require("../utils/membership-pricing");
const { calculateOrderTotals } = require("../utils/pricing");

// ==========================================
// MEMBERSHIP (Bronze / Silver / Gold)
//
// Built on the existing subscription tables:
//   subscription_plans          -> the tiers (tier_rank > 0 marks a membership tier)
//   subscription_plan_benefits  -> benefit lines shown to customers
//   subscriptions               -> one row per purchase attempt / term
// plus membership_product_prices (per-product rules) from scripts/sql/membership_phase1.sql.
//
// Dates are compared with JS Date parameters (never UTC_TIMESTAMP) so they stay
// consistent with how mysql2 writes the dates this module stores.
// ==========================================

const httpError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const PENDING_REUSE_MS = 30 * 60 * 1000;
const PENDING_ABANDON_MS = 24 * 60 * 60 * 1000;

// Until membership_phase1.sql is applied the new columns/table do not exist.
// Pricing must then behave exactly as before instead of breaking checkout.
const notMigrated = (error) =>
  Boolean(error) && [1054, 1146].includes(error.errno);

// ---------- settings ----------

const getSettings = async (executor) => {
  try {
    const [rows] = await executor.execute(
      "SELECT value FROM store_settings WHERE section = 'membership' LIMIT 1"
    );
    const stored = rows[0] ? JSON.parse(rows[0].value) : {};
    const cap = Number(stored.maxTotalDiscountPercent);
    return {
      maxTotalDiscountPercent:
        Number.isFinite(cap) && cap >= 0 && cap <= 100 ? cap : DEFAULT_MAX_TOTAL_DISCOUNT_PERCENT,
    };
  } catch (_) {
    return { maxTotalDiscountPercent: DEFAULT_MAX_TOTAL_DISCOUNT_PERCENT };
  }
};

const updateSettings = async ({ maxTotalDiscountPercent }, req) => {
  const cap = Number(maxTotalDiscountPercent);
  if (!Number.isFinite(cap) || cap < 0 || cap > 100) {
    throw httpError("Maximum total discount must be between 0 and 100.");
  }
  const pool = await poolPromise;
  const before = await getSettings(pool);
  await pool.execute(
    `INSERT INTO store_settings (section, value, updated_by, updated_at)
     VALUES ('membership', ?, ?, UTC_TIMESTAMP(6))
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
    [JSON.stringify({ maxTotalDiscountPercent: cap }), req.user.id]
  );
  await audit.record({
    req,
    action: "membership.settings.update",
    resourceType: "membership_settings",
    resourceId: "membership",
    before,
    after: { maxTotalDiscountPercent: cap },
  });
  return { maxTotalDiscountPercent: cap };
};

// ---------- plans ----------

const PLAN_COLUMNS = `
  p.id, p.name, p.slug, p.description, p.price, p.duration_days, p.tier_rank,
  p.free_delivery, p.discount_percent, p.active, p.created_at, p.updated_at
`;

const shapePlan = (row, benefits) => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  description: row.description,
  price: Number(row.price),
  durationDays: Number(row.duration_days),
  tierRank: Number(row.tier_rank),
  freeDelivery: Boolean(row.free_delivery),
  discountPercent: Number(row.discount_percent),
  active: Boolean(row.active),
  benefits: benefits.map((b) => ({
    id: b.id,
    type: b.benefit_type,
    value: b.benefit_value == null ? null : Number(b.benefit_value),
    description: b.description,
    active: Boolean(b.active),
  })),
});

const loadPlans = async (executor, { onlyActive, planId } = {}) => {
  const where = ["p.tier_rank > 0"];
  const params = [];
  if (onlyActive) where.push("p.active = 1");
  if (planId) {
    where.push("p.id = ?");
    params.push(planId);
  }
  const [plans] = await executor.execute(
    `SELECT ${PLAN_COLUMNS} FROM subscription_plans p WHERE ${where.join(" AND ")} ORDER BY p.tier_rank ASC`,
    params
  );
  if (plans.length === 0) return [];

  const [benefits] = await executor.execute(
    `SELECT id, plan_id, benefit_type, benefit_value, description, active
     FROM subscription_plan_benefits
     ${onlyActive ? "WHERE active = 1" : ""}
     ORDER BY created_at ASC`
  );
  return plans.map((plan) =>
    shapePlan(plan, benefits.filter((b) => b.plan_id === plan.id))
  );
};

const getPublicPlans = async () => {
  const pool = await poolPromise;
  try {
    return await loadPlans(pool, { onlyActive: true });
  } catch (error) {
    if (notMigrated(error)) return [];
    throw error;
  }
};

// ---------- a customer's membership ----------

// The term that is in force right now (started, not ended). Highest tier wins.
const getCurrentTerm = async (executor, userId, now = new Date()) => {
  const [rows] = await executor.execute(
    `SELECT s.id, s.plan_id, s.status, s.start_date, s.end_date, p.name AS plan_name,
            p.slug AS plan_slug, p.tier_rank, p.discount_percent, p.free_delivery
     FROM subscriptions s
     INNER JOIN subscription_plans p ON p.id = s.plan_id
     WHERE s.user_id = ? AND s.status = 'active' AND p.tier_rank > 0
       AND s.start_date <= ? AND s.end_date > ?
     ORDER BY p.tier_rank DESC, s.end_date DESC
     LIMIT 1`,
    [userId, now, now]
  );
  return rows[0] || null;
};

// A renewal that has been paid for but has not started yet.
const getQueuedTerm = async (executor, userId, now = new Date()) => {
  const [rows] = await executor.execute(
    `SELECT s.id, s.plan_id, s.start_date, s.end_date, p.tier_rank
     FROM subscriptions s
     INNER JOIN subscription_plans p ON p.id = s.plan_id
     WHERE s.user_id = ? AND s.status = 'active' AND p.tier_rank > 0 AND s.start_date > ?
     ORDER BY s.start_date ASC
     LIMIT 1`,
    [userId, now]
  );
  return rows[0] || null;
};

const shapeTerm = (row) =>
  row && {
    id: row.id,
    planId: row.plan_id,
    planName: row.plan_name,
    planSlug: row.plan_slug,
    tierRank: Number(row.tier_rank),
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
  };

const getMyMembership = async (userId) => {
  const pool = await poolPromise;
  const now = new Date();

  const [currentRow, queuedRow] = await Promise.all([
    getCurrentTerm(pool, userId, now),
    getQueuedTerm(pool, userId, now),
  ]);

  const [history] = await pool.execute(
    `SELECT s.id, s.status, s.start_date, s.end_date, s.created_at, s.amount, s.payment_status,
            s.razorpay_order_id, s.razorpay_payment_id, p.name AS plan_name, p.slug AS plan_slug,
            p.tier_rank
     FROM subscriptions s
     INNER JOIN subscription_plans p ON p.id = s.plan_id
     WHERE s.user_id = ? AND p.tier_rank > 0
     ORDER BY s.created_at DESC
     LIMIT 50`,
    [userId]
  );

  const plans = currentRow ? await loadPlans(pool, { planId: currentRow.plan_id }) : [];
  const [profile] = await pool.execute("SELECT birthday FROM profiles WHERE id = ? LIMIT 1", [userId]);

  return {
    current: currentRow && {
      ...shapeTerm(currentRow),
      discountPercent: Number(currentRow.discount_percent),
      freeDelivery: Boolean(currentRow.free_delivery),
      benefits: plans[0]?.benefits.filter((b) => b.active) || [],
    },
    queued: shapeTerm(queuedRow),
    birthday: profile[0]?.birthday || null,
    history: history.map((h) => ({
      id: h.id,
      planName: h.plan_name,
      planSlug: h.plan_slug,
      status: h.status,
      paymentStatus: h.payment_status,
      amount: h.amount == null ? null : Number(h.amount),
      startDate: h.start_date,
      endDate: h.end_date,
      purchasedAt: h.created_at,
      razorpayOrderId: h.razorpay_order_id,
      razorpayPaymentId: h.razorpay_payment_id,
    })),
  };
};

const setBirthday = async (userId, value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) || Number.isNaN(Date.parse(value))) {
    throw httpError("Enter a valid birth date.");
  }
  if (new Date(value) > new Date()) throw httpError("Enter a valid birth date.");
  const pool = await poolPromise;
  await pool.execute("UPDATE profiles SET birthday = ? WHERE id = ?", [value, userId]);
  return { birthday: value };
};

// ---------- purchase ----------

const startPurchase = async ({ userId, planId }) => {
  if (!razorpay.isConfigured()) throw httpError("Online payments are not configured.", 503);

  const pool = await poolPromise;
  const plans = await loadPlans(pool, { onlyActive: true, planId });
  const plan = plans[0];
  if (!plan) throw httpError("This membership plan is not available.", 404);

  const now = new Date();
  const [current, queued] = await Promise.all([
    getCurrentTerm(pool, userId, now),
    getQueuedTerm(pool, userId, now),
  ]);
  const decision = decidePurchase({
    current,
    queued,
    target: { tier_rank: plan.tierRank },
    now,
  });
  if (decision.action === "blocked") throw httpError(decision.reason, 409);

  // Same customer + same plan, started moments ago: hand back the same Razorpay
  // order instead of creating a second one (double click / retry).
  const [reusable] = await pool.execute(
    `SELECT id, razorpay_order_id, amount FROM subscriptions
     WHERE user_id = ? AND plan_id = ? AND status = 'pending' AND payment_status = 'created'
       AND razorpay_order_id IS NOT NULL AND created_at > ?
     ORDER BY created_at DESC LIMIT 1`,
    [userId, plan.id, new Date(now.getTime() - PENDING_REUSE_MS)]
  );

  let subscriptionId;
  let razorpayOrderId;
  let amount;

  if (reusable[0] && Number(reusable[0].amount) === plan.price) {
    subscriptionId = reusable[0].id;
    razorpayOrderId = reusable[0].razorpay_order_id;
    amount = plan.price;
  } else {
    subscriptionId = crypto.randomUUID();
    amount = plan.price;
    const order = await razorpay.createOrder({
      amountRupees: amount,
      receipt: `MEM-${subscriptionId.slice(0, 8)}`,
      notes: { type: "membership", subscription_id: subscriptionId, plan: plan.slug },
    });
    razorpayOrderId = order.id;
    await pool.execute(
      `INSERT INTO subscriptions
         (id, user_id, plan_id, status, start_date, end_date, auto_renew, payment_id,
          razorpay_order_id, amount, payment_status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', NULL, NULL, 0, NULL, ?, ?, 'created', ?, ?)`,
      [subscriptionId, userId, plan.id, razorpayOrderId, amount, now, now]
    );
  }

  return {
    keyId: razorpay.getCredentials().keyId,
    razorpayOrderId,
    amount: razorpay.toPaise(amount),
    currency: "INR",
    subscriptionId,
    action: decision.action,
    plan: { id: plan.id, name: plan.name, slug: plan.slug },
  };
};

// Refund a payment we cannot honour (plan rule changed while paying, etc.). On any
// failure the row stays visible to admins as refund_pending - never silently lost.
const refundBack = async (pool, row, paymentId) => {
  let status = "refunded";
  try {
    await razorpay.refundPayment(paymentId, row.amount);
  } catch (error) {
    status = "refund_pending";
    console.error("Membership auto-refund failed | subscription:", row.id, "|", razorpay.describeError(error));
  }
  await pool.execute(
    `UPDATE subscriptions SET status = 'cancelled', payment_status = ?, razorpay_payment_id = COALESCE(razorpay_payment_id, ?),
       payment_id = COALESCE(payment_id, ?), updated_at = ?
     WHERE id = ? AND status = 'pending'`,
    [status, paymentId, paymentId, new Date(), row.id]
  );
};

// Activates a purchase from a verified payment. Idempotent: the same payment
// settled twice (verify + webhook + sync) activates exactly once.
// Returns { outcome: 'activated' | 'already_active' | 'refunded' | 'unknown_order' | 'amount_mismatch' }.
const settlePayment = async ({ razorpayOrderId, paymentId, amountPaise, userId }) => {
  const pool = await poolPromise;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT s.id, s.user_id, s.plan_id, s.status, s.amount, s.payment_status, s.razorpay_payment_id,
              p.duration_days, p.tier_rank, p.active
       FROM subscriptions s INNER JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.razorpay_order_id = ? LIMIT 1 FOR UPDATE`,
      [razorpayOrderId]
    );
    const row = rows[0];
    if (!row || (userId && row.user_id !== userId)) {
      await connection.rollback();
      return { outcome: "unknown_order" };
    }

    if (row.razorpay_payment_id && row.razorpay_payment_id === paymentId && row.status === "active") {
      await connection.rollback();
      return { outcome: "already_active", subscriptionId: row.id };
    }
    if (row.status !== "pending") {
      // Already settled by another payment, or cancelled/expired: this one is a duplicate.
      await connection.rollback();
      return { outcome: "duplicate", subscriptionId: row.id };
    }
    if (amountPaise != null && Number(amountPaise) !== razorpay.toPaise(row.amount)) {
      await connection.rollback();
      return { outcome: "amount_mismatch", subscriptionId: row.id };
    }

    // Lock this customer's membership rows so two purchases cannot both start "now".
    await connection.execute("SELECT id FROM subscriptions WHERE user_id = ? FOR UPDATE", [row.user_id]);

    const now = new Date();
    const [current, queued] = await Promise.all([
      getCurrentTerm(connection, row.user_id, now),
      getQueuedTerm(connection, row.user_id, now),
    ]);
    const decision = decidePurchase({ current, queued, target: { tier_rank: row.tier_rank }, now });

    if (decision.action === "blocked") {
      await connection.rollback();
      await refundBack(pool, row, paymentId);
      return { outcome: "refunded", reason: decision.reason, subscriptionId: row.id };
    }

    if (decision.action === "upgrade") {
      // The lower term(s) end now; no pro-rata credit by policy.
      await connection.execute(
        `UPDATE subscriptions s INNER JOIN subscription_plans p ON p.id = s.plan_id
         SET s.status = 'expired', s.end_date = ?, s.updated_at = ?
         WHERE s.user_id = ? AND s.status = 'active' AND p.tier_rank > 0 AND s.start_date <= ? AND s.end_date > ?`,
        [now, now, row.user_id, now, now]
      );
      await connection.execute(
        `UPDATE subscriptions s INNER JOIN subscription_plans p ON p.id = s.plan_id
         SET s.status = 'cancelled', s.updated_at = ?
         WHERE s.user_id = ? AND s.status = 'active' AND p.tier_rank > 0 AND s.start_date > ?`,
        [now, row.user_id, now]
      );
    }

    const startDate = decision.startDate;
    const endDate = addDays(startDate, row.duration_days);

    await connection.execute(
      `UPDATE subscriptions
       SET status = 'active', start_date = ?, end_date = ?, payment_status = 'paid',
           razorpay_payment_id = ?, payment_id = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      [startDate, endDate, paymentId, paymentId, now, row.id]
    );

    await connection.commit();
    return { outcome: "activated", subscriptionId: row.id, action: decision.action, startDate, endDate };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    throw error;
  } finally {
    connection.release();
  }
};

// Customer's browser reports the Razorpay result. The signature is checked here;
// nothing is activated on the client's word alone.
const verifyPurchase = async ({ userId, razorpayOrderId, razorpayPaymentId, signature }) => {
  const valid = razorpay.verifySignature({ razorpayOrderId, razorpayPaymentId, signature });
  if (!valid) {
    await markFailed({ userId, razorpayOrderId });
    throw httpError("Payment verification failed.");
  }
  const result = await settlePayment({ razorpayOrderId, paymentId: razorpayPaymentId, userId });
  if (result.outcome === "unknown_order") throw httpError("Payment does not match a membership order.", 404);
  if (result.outcome === "refunded") {
    throw httpError(`${result.reason} Your payment will be refunded.`, 409);
  }
  if (result.outcome === "duplicate") {
    throw httpError("This membership order has already been processed.", 409);
  }
  if (result.outcome === "amount_mismatch") throw httpError("Payment amount does not match.", 400);
  return result;
};

const markFailed = async ({ userId, razorpayOrderId }) => {
  const pool = await poolPromise;
  await pool.execute(
    `UPDATE subscriptions SET payment_status = 'failed', updated_at = ?
     WHERE razorpay_order_id = ? AND user_id = ? AND status = 'pending' AND payment_status = 'created'`,
    [new Date(), razorpayOrderId, userId]
  );
  return { razorpayOrderId, paymentStatus: "failed" };
};

// Customer closed the tab after paying: ask Razorpay and settle if captured.
const syncPurchase = async ({ userId, razorpayOrderId }) => {
  const pool = await poolPromise;
  const [rows] = await pool.execute(
    "SELECT id, status, amount FROM subscriptions WHERE razorpay_order_id = ? AND user_id = ? LIMIT 1",
    [razorpayOrderId, userId]
  );
  const row = rows[0];
  if (!row) throw httpError("Membership order not found.", 404);
  if (row.status !== "pending") return { activated: row.status === "active", status: row.status };

  const payments = await razorpay.fetchOrderPayments(razorpayOrderId);
  const captured = payments.find(
    (p) => p.status === "captured" && Number(p.amount) === razorpay.toPaise(row.amount)
  );
  if (!captured) return { activated: false, status: "pending" };

  const result = await settlePayment({ razorpayOrderId, paymentId: captured.id, amountPaise: captured.amount, userId });
  return { activated: result.outcome === "activated" || result.outcome === "already_active", status: result.outcome };
};

// Razorpay webhook (payment.captured / order.paid) for membership orders.
const settleWebhookPayment = async ({ razorpayOrderId, paymentId, amountPaise }) => {
  if (!razorpayOrderId || !paymentId) return { handled: false, reason: "missing_ids" };
  let result;
  try {
    result = await settlePayment({ razorpayOrderId, paymentId, amountPaise });
  } catch (error) {
    if (notMigrated(error)) return { handled: false, reason: "unknown_order" };
    throw error;
  }
  if (result.outcome === "unknown_order") return { handled: false, reason: "unknown_order" };
  if (result.outcome === "amount_mismatch") return { handled: false, reason: "amount_mismatch" };
  return { handled: true, outcome: result.outcome };
};

// Housekeeping (run on a timer): ends terms past their end date and closes purchases
// that were never paid. Reads already treat past-end terms as expired either way.
const sweep = async () => {
  const pool = await poolPromise;
  const now = new Date();
  const [expired] = await pool.execute(
    `UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE status = 'active' AND end_date <= ?`,
    [now, now]
  );
  const [abandoned] = await pool.execute(
    `UPDATE subscriptions SET status = 'cancelled', updated_at = ?
     WHERE status = 'pending' AND razorpay_order_id IS NOT NULL AND created_at < ?`,
    [now, new Date(now.getTime() - PENDING_ABANDON_MS)]
  );
  return { expired: expired.affectedRows, abandoned: abandoned.affectedRows };
};

// ---------- member pricing (used by cart / checkout / order) ----------

// Returns null for guests, non-members, or while the migration is not applied.
const getMemberContext = async (executor, userId) => {
  if (!userId) return null;
  try {
    const term = await getCurrentTerm(executor, userId);
    if (!term) return null;
    return {
      planId: term.plan_id,
      planName: term.plan_name,
      planSlug: term.plan_slug,
      tierRank: Number(term.tier_rank),
      discountPercent: Number(term.discount_percent),
      freeDelivery: Boolean(term.free_delivery),
    };
  } catch (error) {
    if (notMigrated(error)) return null;
    throw error;
  }
};

const loadRules = async (executor, planId, productIds) => {
  const ids = [...new Set(productIds)].filter(Boolean);
  if (ids.length === 0) return new Map();
  const [rows] = await executor.execute(
    `SELECT product_id, eligible, member_price FROM membership_product_prices
     WHERE plan_id = ? AND product_id IN (${ids.map(() => "?").join(",")})`,
    [planId, ...ids]
  );
  return new Map(rows.map((r) => [r.product_id, r]));
};

// lines: [{ productId, price, mrp }]. Returns the member context (or null) and
// the payable unit price for each line, in the same order.
const priceLines = async (executor, userId, lines) => {
  const member = await getMemberContext(executor, userId);
  const settings = await getSettings(executor);
  if (!member) {
    return { member: null, maxTotalDiscountPercent: settings.maxTotalDiscountPercent, unitPrices: lines.map((l) => Number(l.price)) };
  }
  const rules = await loadRules(executor, member.planId, lines.map((l) => l.productId));
  return {
    member,
    maxTotalDiscountPercent: settings.maxTotalDiscountPercent,
    unitPrices: lines.map((l) =>
      memberUnitPrice({
        price: l.price,
        mrp: l.mrp,
        discountPercent: member.discountPercent,
        rule: rules.get(l.productId),
        maxTotalDiscountPercent: settings.maxTotalDiscountPercent,
      })
    ),
  };
};

// Cart view for a signed-in customer: member unit price per item plus the totals the
// order would get (same maths as order creation). Best effort: any failure means
// "show the regular cart", never a wrong price (checkout recomputes anyway).
const priceCart = async (userId, items, couponCode) => {
  try {
    const pool = await poolPromise;
    const priced = await priceLines(
      pool,
      userId,
      items.map((i) => ({ productId: i.product_id, price: i.price_snapshot, mrp: i.mrp_snapshot }))
    );
    if (!priced.member) return null;

    const lines = items.map((item, index) => ({
      id: item.id,
      memberPrice: priced.unitPrices[index],
      quantity: Number(item.quantity),
      mrp: Number(item.mrp_snapshot),
    }));
    const subtotal = lines.reduce((t, l) => t + l.memberPrice * l.quantity, 0);
    const listSubtotal = lines.reduce((t, l) => t + l.mrp * l.quantity, 0);

    let couponDiscount = 0;
    if (couponCode) {
      try {
        const result = await couponService.validateCoupon(couponCode, subtotal);
        couponDiscount = capCouponDiscount({
          couponDiscount: result.discount,
          listSubtotal,
          payableSubtotal: subtotal,
          maxTotalDiscountPercent: priced.maxTotalDiscountPercent,
        });
      } catch (_) {
        couponDiscount = 0;
      }
    }

    const totals = calculateOrderTotals(subtotal, couponDiscount, { freeShipping: priced.member.freeDelivery });
    return {
      member: { planName: priced.member.planName, planSlug: priced.member.planSlug, freeDelivery: priced.member.freeDelivery },
      memberPrices: Object.fromEntries(lines.map((l) => [l.id, l.memberPrice])),
      totals,
    };
  } catch (error) {
    if (!notMigrated(error)) console.error("Member cart pricing failed:", error.message);
    return null;
  }
};

// For the storefront: the signed-in member's price for each product (display only;
// the server recomputes at cart/checkout).
const getMyPricing = async (userId, productIds) => {
  const pool = await poolPromise;
  const member = await getMemberContext(pool, userId);
  if (!member) return { member: null, prices: {} };

  const where = productIds && productIds.length ? `WHERE id IN (${productIds.map(() => "?").join(",")})` : "";
  const [products] = await pool.execute(
    `SELECT id, price, mrp FROM products ${where} LIMIT 500`,
    productIds || []
  );
  const priced = await priceLines(pool, userId, products.map((p) => ({ productId: p.id, price: p.price, mrp: p.mrp })));
  const prices = {};
  products.forEach((p, i) => {
    if (priced.unitPrices[i] < Number(p.price)) prices[p.id] = priced.unitPrices[i];
  });
  return {
    member: { planName: member.planName, planSlug: member.planSlug, tierRank: member.tierRank, discountPercent: member.discountPercent, freeDelivery: member.freeDelivery },
    prices,
  };
};

// For guests, non-members and expired members: what the entry tier (lowest active
// tier) would charge, so the storefront can say "Join and save Rs X". Same maths as
// priceLines (product rules, sale-price stacking, discount cap). Display only.
const PREVIEW_TTL_MS = 60 * 1000;
let previewCache = { at: 0, key: "", value: null };

const getPreviewPricing = async (productIds) => {
  const ids = productIds && productIds.length ? [...new Set(productIds)].sort() : null;
  const key = ids ? ids.join(",") : "*";
  if (previewCache.value && previewCache.key === key && Date.now() - previewCache.at < PREVIEW_TTL_MS) {
    return previewCache.value;
  }

  const pool = await poolPromise;
  let plans;
  try {
    plans = await loadPlans(pool, { onlyActive: true });
  } catch (error) {
    if (notMigrated(error)) return { plan: null, prices: {} };
    throw error;
  }
  const plan = plans[0];
  if (!plan) return { plan: null, prices: {} };

  const where = ids ? `WHERE id IN (${ids.map(() => "?").join(",")})` : "";
  const [products] = await pool.execute(`SELECT id, price, mrp FROM products ${where} LIMIT 500`, ids || []);
  const [settings, rules] = await Promise.all([
    getSettings(pool),
    loadRules(pool, plan.id, products.map((p) => p.id)),
  ]);

  const prices = {};
  products.forEach((p) => {
    const unit = memberUnitPrice({
      price: p.price,
      mrp: p.mrp,
      discountPercent: plan.discountPercent,
      rule: rules.get(p.id),
      maxTotalDiscountPercent: settings.maxTotalDiscountPercent,
    });
    if (unit < Number(p.price)) prices[p.id] = unit;
  });

  const value = {
    plan: { name: plan.name, slug: plan.slug, price: plan.price, discountPercent: plan.discountPercent, freeDelivery: plan.freeDelivery },
    prices,
  };
  previewCache = { at: Date.now(), key, value };
  return value;
};

// ---------- admin ----------

const num = (label, value, { min = 0, max = 1e7 } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw httpError(`${label} must be between ${min} and ${max}.`);
  return n;
};

const cleanText = (label, value, max, required = false) => {
  const v = typeof value === "string" ? value.trim() : "";
  if (required && !v) throw httpError(`${label} is required.`);
  if (v.length > max) throw httpError(`${label} must be at most ${max} characters.`);
  return v;
};

const BENEFIT_TYPE = /^[A-Z_]{2,50}$/;

const validatePlanInput = (input, { partial = false } = {}) => {
  const out = {};
  const has = (k) => input[k] !== undefined;
  if (!partial || has("name")) out.name = cleanText("Name", input.name, 100, true);
  if (!partial || has("slug")) {
    out.slug = cleanText("Slug", input.slug, 100, true).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(out.slug)) throw httpError("Slug can only contain letters, numbers and dashes.");
  }
  if (!partial || has("description")) out.description = cleanText("Description", input.description || "", 1000);
  if (!partial || has("price")) out.price = num("Price", input.price, { min: 1, max: 100000 });
  if (!partial || has("durationDays")) {
    out.duration_days = num("Validity", input.durationDays, { min: 1, max: 3650 });
    if (!Number.isInteger(out.duration_days)) throw httpError("Validity must be a whole number of days.");
  }
  if (!partial || has("tierRank")) {
    out.tier_rank = num("Tier order", input.tierRank, { min: 1, max: 100 });
    if (!Number.isInteger(out.tier_rank)) throw httpError("Tier order must be a whole number.");
  }
  if (!partial || has("discountPercent")) out.discount_percent = num("Discount", input.discountPercent, { min: 0, max: 100 });
  if (!partial || has("freeDelivery")) out.free_delivery = input.freeDelivery ? 1 : 0;
  if (!partial || has("active")) out.active = input.active === false ? 0 : 1;
  return out;
};

const validateBenefits = (benefits) => {
  if (!Array.isArray(benefits) || benefits.length > 30) throw httpError("Benefits must be a list of at most 30 items.");
  return benefits.map((b) => {
    const type = String(b.type || "").toUpperCase();
    if (!BENEFIT_TYPE.test(type)) throw httpError("Benefit type must be letters and underscores only.");
    return {
      type,
      value: b.value === null || b.value === undefined || b.value === "" ? null : num("Benefit value", b.value, { min: 0, max: 100000 }),
      description: cleanText("Benefit description", b.description || "", 255, true),
      active: b.active === false ? 0 : 1,
    };
  });
};

// Benefits are replaced by soft-deactivating rows that disappeared and upserting the rest by type,
// so history of what a plan used to promise is not destroyed.
const writeBenefits = async (connection, planId, benefits) => {
  const [existing] = await connection.execute(
    "SELECT id, benefit_type FROM subscription_plan_benefits WHERE plan_id = ?",
    [planId]
  );
  const kept = new Set();
  for (const b of benefits) {
    const match = existing.find((e) => e.benefit_type === b.type);
    kept.add(b.type);
    if (match) {
      await connection.execute(
        "UPDATE subscription_plan_benefits SET benefit_value = ?, description = ?, active = ?, updated_at = ? WHERE id = ?",
        [b.value, b.description, b.active, new Date(), match.id]
      );
    } else {
      await connection.execute(
        "INSERT INTO subscription_plan_benefits (id, plan_id, benefit_type, benefit_value, description, active) VALUES (?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), planId, b.type, b.value, b.description, b.active]
      );
    }
  }
  for (const e of existing) {
    if (!kept.has(e.benefit_type)) {
      await connection.execute("UPDATE subscription_plan_benefits SET active = 0, updated_at = ? WHERE id = ?", [new Date(), e.id]);
    }
  }
};

const adminListPlans = async () => {
  const pool = await poolPromise;
  return loadPlans(pool, {});
};

const adminSavePlan = async ({ planId, input, req }) => {
  const pool = await poolPromise;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    let before = null;
    let id = planId;
    const benefits = input.benefits === undefined ? null : validateBenefits(input.benefits);

    if (planId) {
      const existing = await loadPlans(connection, { planId });
      before = existing[0];
      if (!before) throw httpError("Plan not found.", 404);
      const fields = validatePlanInput(input, { partial: true });
      const keys = Object.keys(fields);
      if (keys.length) {
        await connection.execute(
          `UPDATE subscription_plans SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
          [...keys.map((k) => fields[k]), new Date(), planId]
        );
      }
    } else {
      const fields = validatePlanInput(input);
      id = crypto.randomUUID();
      const keys = ["id", ...Object.keys(fields)];
      await connection.execute(
        `INSERT INTO subscription_plans (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
        [id, ...Object.keys(fields).map((k) => fields[k])]
      );
    }

    if (benefits) await writeBenefits(connection, id, benefits);
    await connection.commit();

    const [after] = await loadPlans(pool, { planId: id });
    await audit.record({
      req,
      action: planId ? "membership.plan.update" : "membership.plan.create",
      resourceType: "membership_plan",
      resourceId: id,
      before,
      after,
    });
    return after;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    if (error.code === "ER_DUP_ENTRY") throw httpError("A plan with this slug already exists.", 409);
    throw error;
  } finally {
    connection.release();
  }
};

const adminListPurchases = async ({ status, paymentStatus, q, page = 1, limit = 25 } = {}) => {
  const pool = await poolPromise;
  const where = ["p.tier_rank > 0"];
  const params = [];
  if (status) {
    where.push("s.status = ?");
    params.push(String(status));
  }
  if (paymentStatus) {
    where.push("s.payment_status = ?");
    params.push(String(paymentStatus));
  }
  if (q) {
    where.push("(u.email LIKE ? OR u.full_name LIKE ? OR s.razorpay_order_id = ? OR s.razorpay_payment_id = ?)");
    const like = `%${String(q).slice(0, 80)}%`;
    params.push(like, like, String(q), String(q));
  }
  const size = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * size;
  const now = new Date();

  const [rows] = await pool.execute(
    `SELECT s.id, s.user_id, s.status, s.start_date, s.end_date, s.created_at, s.amount, s.payment_status,
            s.razorpay_order_id, s.razorpay_payment_id, p.name AS plan_name, p.slug AS plan_slug,
            u.email, u.full_name
     FROM subscriptions s
     INNER JOIN subscription_plans p ON p.id = s.plan_id
     INNER JOIN profiles u ON u.id = s.user_id
     WHERE ${where.join(" AND ")}
     ORDER BY s.created_at DESC
     LIMIT ${size} OFFSET ${offset}`,
    params
  );
  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM subscriptions s
     INNER JOIN subscription_plans p ON p.id = s.plan_id
     INNER JOIN profiles u ON u.id = s.user_id WHERE ${where.join(" AND ")}`,
    params
  );
  const [[summary]] = await pool.execute(
    `SELECT
       COALESCE(SUM(s.status = 'active' AND s.start_date <= ? AND s.end_date > ?), 0) AS active_members,
       COALESCE(SUM(s.status = 'expired' OR (s.status = 'active' AND s.end_date <= ?)), 0) AS expired_members,
       COALESCE(SUM(CASE WHEN s.payment_status = 'paid' THEN s.amount ELSE 0 END), 0) AS revenue
     FROM subscriptions s INNER JOIN subscription_plans p ON p.id = s.plan_id WHERE p.tier_rank > 0`,
    [now, now, now]
  );

  return {
    total: Number(total),
    page: Math.max(parseInt(page, 10) || 1, 1),
    limit: size,
    summary: {
      activeMembers: Number(summary.active_members),
      expiredMembers: Number(summary.expired_members),
      revenue: Number(summary.revenue),
    },
    purchases: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      email: r.email,
      name: r.full_name,
      planName: r.plan_name,
      planSlug: r.plan_slug,
      status: r.status === "active" && new Date(r.end_date) <= now ? "expired" : r.status,
      paymentStatus: r.payment_status,
      amount: r.amount == null ? null : Number(r.amount),
      startDate: r.start_date,
      endDate: r.end_date,
      purchasedAt: r.created_at,
      razorpayOrderId: r.razorpay_order_id,
      razorpayPaymentId: r.razorpay_payment_id,
    })),
  };
};

// Manual status management. Always needs a reason and is audited.
//   cancel      active/pending -> cancelled
//   reactivate  cancelled (term not yet over) -> active
//   grant       gives a customer a term of a plan without a payment (complimentary)
const adminChangeStatus = async ({ subscriptionId, userId, planId, action, reason, req }) => {
  const why = cleanText("Reason", reason, 500, true);
  if (!["cancel", "reactivate", "grant"].includes(action)) throw httpError("Unknown action.");
  const pool = await poolPromise;
  const now = new Date();

  if (action === "grant") {
    const [plans] = await pool.execute(
      "SELECT id, duration_days, tier_rank FROM subscription_plans WHERE id = ? AND tier_rank > 0 LIMIT 1",
      [planId]
    );
    if (!plans[0]) throw httpError("Plan not found.", 404);
    const [users] = await pool.execute("SELECT id FROM profiles WHERE id = ? AND role = 'customer' LIMIT 1", [userId]);
    if (!users[0]) throw httpError("Customer not found.", 404);
    const current = await getCurrentTerm(pool, userId, now);
    if (current && Number(current.tier_rank) >= Number(plans[0].tier_rank)) {
      throw httpError("This customer already has an equal or higher membership.", 409);
    }
    if (current) {
      await pool.execute("UPDATE subscriptions SET status = 'expired', end_date = ?, updated_at = ? WHERE id = ?", [now, now, current.id]);
    }
    const id = crypto.randomUUID();
    await pool.execute(
      `INSERT INTO subscriptions (id, user_id, plan_id, status, start_date, end_date, auto_renew, amount, payment_status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, 0, 0, 'none', ?, ?)`,
      [id, userId, plans[0].id, now, addDays(now, plans[0].duration_days), now, now]
    );
    await audit.record({ req, action: "membership.grant", resourceType: "subscription", resourceId: id, reason: why, after: { userId, planId } });
    return { id, status: "active" };
  }

  const [rows] = await pool.execute("SELECT id, status, start_date, end_date FROM subscriptions WHERE id = ? LIMIT 1", [subscriptionId]);
  const row = rows[0];
  if (!row) throw httpError("Membership not found.", 404);

  if (action === "cancel") {
    if (!["active", "pending"].includes(row.status)) throw httpError("Only an active or pending membership can be cancelled.", 409);
    await pool.execute("UPDATE subscriptions SET status = 'cancelled', auto_renew = 0, updated_at = ? WHERE id = ?", [now, row.id]);
  } else {
    if (row.status !== "cancelled" || !row.end_date || new Date(row.end_date) <= now || !row.start_date) {
      throw httpError("Only a cancelled membership that has not ended can be reactivated.", 409);
    }
    await pool.execute("UPDATE subscriptions SET status = 'active', updated_at = ? WHERE id = ?", [now, row.id]);
  }

  await audit.record({
    req,
    action: `membership.${action}`,
    resourceType: "subscription",
    resourceId: row.id,
    reason: why,
    before: { status: row.status },
    after: { status: action === "cancel" ? "cancelled" : "active" },
  });
  return { id: row.id, status: action === "cancel" ? "cancelled" : "active" };
};

const adminListProductRules = async (planId) => {
  const pool = await poolPromise;
  const [products] = await pool.execute("SELECT id, name, price, mrp FROM products ORDER BY name ASC LIMIT 500");
  const [rules] = await pool.execute(
    "SELECT product_id, eligible, member_price FROM membership_product_prices WHERE plan_id = ?",
    [planId]
  );
  const byProduct = new Map(rules.map((r) => [r.product_id, r]));
  return products.map((p) => ({
    productId: p.id,
    name: p.name,
    price: Number(p.price),
    mrp: Number(p.mrp),
    eligible: byProduct.has(p.id) ? Boolean(byProduct.get(p.id).eligible) : true,
    memberPrice: byProduct.get(p.id)?.member_price == null ? null : Number(byProduct.get(p.id).member_price),
    hasRule: byProduct.has(p.id),
  }));
};

const adminSetProductRule = async ({ planId, productId, eligible, memberPrice, req }) => {
  const pool = await poolPromise;
  const [plan] = await pool.execute("SELECT id FROM subscription_plans WHERE id = ? AND tier_rank > 0 LIMIT 1", [planId]);
  if (!plan[0]) throw httpError("Plan not found.", 404);
  const [product] = await pool.execute("SELECT id, price FROM products WHERE id = ? LIMIT 1", [productId]);
  if (!product[0]) throw httpError("Product not found.", 404);

  const price = memberPrice === null || memberPrice === undefined || memberPrice === "" ? null : num("Member price", memberPrice, { min: 0, max: 1e7 });
  if (price !== null && price > Number(product[0].price)) {
    throw httpError("Member price cannot be higher than the product's selling price.");
  }
  const isEligible = eligible === false ? 0 : 1;

  if (isEligible === 1 && price === null) {
    // Back to the default (plan percentage): the rule row is no longer needed.
    await pool.execute("DELETE FROM membership_product_prices WHERE plan_id = ? AND product_id = ?", [planId, productId]);
  } else {
    await pool.execute(
      `INSERT INTO membership_product_prices (id, plan_id, product_id, eligible, member_price)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE eligible = VALUES(eligible), member_price = VALUES(member_price), updated_at = CURRENT_TIMESTAMP(6)`,
      [crypto.randomUUID(), planId, productId, isEligible, price]
    );
  }
  await audit.record({
    req,
    action: "membership.product_rule",
    resourceType: "membership_plan",
    resourceId: planId,
    after: { productId, eligible: Boolean(isEligible), memberPrice: price },
  });
  return { productId, eligible: Boolean(isEligible), memberPrice: price };
};

module.exports = {
  getSettings,
  updateSettings,
  getPublicPlans,
  getMyMembership,
  setBirthday,
  startPurchase,
  verifyPurchase,
  markFailed,
  syncPurchase,
  settlePayment,
  settleWebhookPayment,
  sweep,
  getMemberContext,
  priceLines,
  priceCart,
  getMyPricing,
  getPreviewPricing,
  adminListPlans,
  adminSavePlan,
  adminListPurchases,
  adminChangeStatus,
  adminListProductRules,
  adminSetProductRule,
};
