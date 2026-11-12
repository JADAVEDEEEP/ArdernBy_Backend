// Membership: pure rules + the REAL membership.service run against an in-memory
// stand-in for the subscription tables. Razorpay is stubbed; nothing touches MySQL.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");

process.env.RAZORPAY_KEY_ID = "rzp_test_unit";
process.env.RAZORPAY_KEY_SECRET = "unit_secret";

const root = path.join(__dirname, "..");
const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();
const DAY = 86400000;

const { decidePurchase } = require("../utils/membership-policy");
const { memberUnitPrice, capCouponDiscount } = require("../utils/membership-pricing");
const { calculateOrderTotals } = require("../utils/pricing");

// ---------------- pure rules ----------------

test("member price: 15% off the selling price, rule override, exclusion, never above price", () => {
  assert.equal(memberUnitPrice({ price: 1000, mrp: 1000, discountPercent: 15 }), 850);
  assert.equal(memberUnitPrice({ price: 1000, mrp: 1000, discountPercent: 15, rule: { eligible: 0 } }), 1000);
  assert.equal(memberUnitPrice({ price: 1000, mrp: 1000, discountPercent: 15, rule: { eligible: 1, member_price: 700 } }), 700);
  assert.equal(memberUnitPrice({ price: 1000, mrp: 1000, discountPercent: 15, rule: { eligible: 1, member_price: 1500 } }), 1000);
});

test("member price applies on top of a sale price (additional 15%), once", () => {
  // The four live products: selling price / MRP.
  assert.equal(memberUnitPrice({ price: 1000, mrp: 1200, discountPercent: 15 }), 850);
  assert.equal(memberUnitPrice({ price: 1199, mrp: 1799, discountPercent: 15 }), 1019.15);
  assert.equal(memberUnitPrice({ price: 899, mrp: 1399, discountPercent: 15 }), 764.15);
  assert.equal(memberUnitPrice({ price: 1290, mrp: 1380, discountPercent: 15 }), 1096.5);
  // Applying it to its own result is the caller's bug; the function is not idempotent by design,
  // so the callers must always pass the product's selling price (covered by the cart/order tests).
});

test("member price: the 60% total discount cap floors the price", () => {
  // list 1000, selling 450 (55% off). 15% more would be 382.5 -> cap 60% keeps it at 400.
  assert.equal(memberUnitPrice({ price: 450, mrp: 1000, discountPercent: 15, maxTotalDiscountPercent: 60 }), 400);
  // Already below the floor: member gets nothing extra, never a price increase.
  assert.equal(memberUnitPrice({ price: 300, mrp: 1000, discountPercent: 15, maxTotalDiscountPercent: 60 }), 300);
  // A fixed member price below the floor is lifted to it.
  assert.equal(memberUnitPrice({ price: 900, mrp: 1000, discountPercent: 15, rule: { eligible: 1, member_price: 100 }, maxTotalDiscountPercent: 60 }), 400);
});

test("coupon is trimmed so sale + member + coupon stay inside the cap", () => {
  assert.equal(capCouponDiscount({ couponDiscount: 300, listSubtotal: 1000, payableSubtotal: 500, maxTotalDiscountPercent: 60 }), 100);
  assert.equal(capCouponDiscount({ couponDiscount: 50, listSubtotal: 1000, payableSubtotal: 900, maxTotalDiscountPercent: 60 }), 50);
  assert.equal(capCouponDiscount({ couponDiscount: 50, listSubtotal: 1000, payableSubtotal: 300, maxTotalDiscountPercent: 60 }), 0);
});

test("shipping: flat Rs 49 for non-members at ANY order value, free for members", () => {
  for (const subtotal of [1, 500, 998, 999, 1000, 5000, 100000]) {
    assert.equal(calculateOrderTotals(subtotal, 0).shippingAmount, 49, `subtotal ${subtotal}`);
    assert.equal(calculateOrderTotals(subtotal, 0, { freeShipping: true }).shippingAmount, 0);
    // A coupon never changes the shipping rule.
    assert.equal(calculateOrderTotals(subtotal, 10).shippingAmount, 49);
  }
  assert.equal(calculateOrderTotals(0, 0).shippingAmount, 0);
  assert.equal(calculateOrderTotals(1000, 0).totalAmount, 1000 + 49 + 50);
});

test("purchase policy: new / renew / blocked (no tiers)", () => {
  const now = new Date("2026-11-02T00:00:00Z");
  const end = new Date(now.getTime() + 100 * DAY);
  assert.equal(decidePurchase({ current: null, queued: null, now }).action, "new");
  const renew = decidePurchase({ current: { end_date: end }, queued: null, now });
  assert.equal(renew.action, "renew");
  assert.equal(renew.startDate.getTime(), end.getTime());
  assert.equal(decidePurchase({ current: { end_date: end }, queued: { end_date: end }, now }).action, "blocked");
});

// ---------------- service against an in-memory store ----------------

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const state = {};
const razorCalls = { orders: [], refunds: [] };
let paymentsForOrder = [];

const planRow = (id, name, rank, price, pct, free) => ({
  id, name, slug: name.toLowerCase(), description: "", price, duration_days: 365, tier_rank: rank,
  free_delivery: free, discount_percent: pct, active: 1, created_at: new Date(), updated_at: new Date(),
});

const reset = () => {
  state.plans = [
    // Retired tiers (hidden from customers, still referenced by old subscriptions).
    { ...planRow("p-bronze", "Bronze", 1, "99.00", "5.00", 0), active: 0 },
    { ...planRow("p-silver", "Silver", 2, "199.00", "8.00", 0), active: 0 },
    { ...planRow("p-gold", "Gold", 3, "399.00", "12.00", 1), active: 0 },
    { ...planRow("p-legacy", "Plus", 0, "99.00", "5.00", 0) },
    // The one plan customers can buy.
    { ...planRow("p-member", "KOVENIK MEMBER", 10, "199.00", "15.00", 0), slug: "kovenik-member" },
  ];
  state.subs = [];
  state.rules = [];
  razorCalls.orders = [];
  razorCalls.refunds = [];
  paymentsForOrder = [];
};

const termView = (s) => {
  const p = state.plans.find((x) => x.id === s.plan_id);
  return { ...s, plan_name: p.name, plan_slug: p.slug, tier_rank: p.tier_rank, discount_percent: p.discount_percent, free_delivery: p.free_delivery, duration_days: p.duration_days, active: p.active };
};

const run = async (sql, p = []) => {
  const t = norm(sql);

  if (t.startsWith("select value from store_settings")) return [[]];
  if (t.includes("from subscription_plan_benefits")) return [[]];

  if (t.includes("from subscription_plans p where")) {
    let rows = state.plans.filter((x) => x.tier_rank > 0);
    if (t.includes("p.active = 1")) rows = rows.filter((x) => x.active);
    if (t.includes("p.slug = 'kovenik-member'")) rows = rows.filter((x) => x.slug === "kovenik-member");
    if (t.includes("p.id = ?")) rows = rows.filter((x) => x.id === p[0]);
    return [rows.sort((a, b) => a.tier_rank - b.tier_rank)];
  }

  if (t.startsWith("select s.id, s.plan_id, s.status, s.start_date, s.end_date, p.name as plan_name")) {
    const [userId, now] = [p[0], p[1]];
    const rows = state.subs
      .filter((s) => s.user_id === userId && s.status === "active" && s.start_date <= now && s.end_date > now)
      .map(termView).filter((s) => s.tier_rank > 0)
      .sort((a, b) => b.tier_rank - a.tier_rank || b.end_date - a.end_date);
    return [rows.slice(0, 1)];
  }

  if (t.startsWith("select s.id, s.plan_id, s.start_date, s.end_date, p.tier_rank")) {
    const [userId, now] = [p[0], p[1]];
    const rows = state.subs
      .filter((s) => s.user_id === userId && s.status === "active" && s.start_date > now)
      .map(termView).sort((a, b) => a.start_date - b.start_date);
    return [rows.slice(0, 1)];
  }

  if (t.includes("from membership_product_prices")) {
    return [state.rules.filter((r) => r.plan_id === p[0] && p.slice(1).includes(r.product_id))];
  }

  if (t.startsWith("select id, razorpay_order_id, amount from subscriptions")) {
    const [userId, planId, since] = p;
    return [state.subs.filter((s) => s.user_id === userId && s.plan_id === planId && s.status === "pending" &&
      s.payment_status === "created" && s.razorpay_order_id && s.created_at > since)];
  }

  if (t.startsWith("insert into subscriptions")) {
    const [id, user_id, plan_id, razorpay_order_id, amount, created_at] = [p[0], p[1], p[2], p[3], p[4], p[5]];
    state.subs.push({ id, user_id, plan_id, status: "pending", start_date: null, end_date: null,
      razorpay_order_id, razorpay_payment_id: null, payment_id: null, amount, payment_status: "created", created_at });
    return [{ affectedRows: 1 }];
  }

  if (t.includes("from subscriptions s inner join subscription_plans p on p.id = s.plan_id where s.razorpay_order_id = ?")) {
    return [state.subs.filter((s) => s.razorpay_order_id === p[0]).map(termView)];
  }
  if (t.startsWith("select id from subscriptions where user_id = ? for update")) return [[]];

  if (t.startsWith("update subscriptions s inner join subscription_plans p on p.id = s.plan_id set s.status = 'expired'")) {
    const [now, , userId, start, end] = [p[0], p[1], p[2], p[3], p[4]];
    state.subs.filter((s) => s.user_id === userId && s.status === "active" && s.start_date <= start && s.end_date > end)
      .forEach((s) => { s.status = "expired"; s.end_date = now; });
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("update subscriptions s inner join subscription_plans p on p.id = s.plan_id set s.status = 'cancelled'")) {
    const [, userId, now] = p;
    state.subs.filter((s) => s.user_id === userId && s.status === "active" && s.start_date > now).forEach((s) => { s.status = "cancelled"; });
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("update subscriptions set status = 'active'")) {
    const [start, end, payId, , , id] = [p[0], p[1], p[2], p[3], p[4], p[5]];
    const s = state.subs.find((x) => x.id === id && x.status === "pending");
    if (s) Object.assign(s, { status: "active", start_date: start, end_date: end, payment_status: "paid", razorpay_payment_id: payId, payment_id: payId });
    return [{ affectedRows: s ? 1 : 0 }];
  }
  if (t.startsWith("update subscriptions set status = 'cancelled', payment_status = ?")) {
    const [status, payId, , , id] = [p[0], p[1], p[2], p[3], p[4]];
    const s = state.subs.find((x) => x.id === id && x.status === "pending");
    if (s) Object.assign(s, { status: "cancelled", payment_status: status, razorpay_payment_id: s.razorpay_payment_id || payId });
    return [{ affectedRows: s ? 1 : 0 }];
  }
  if (t.startsWith("update subscriptions set payment_status = 'failed'")) {
    const s = state.subs.find((x) => x.razorpay_order_id === p[1] && x.user_id === p[2] && x.status === "pending" && x.payment_status === "created");
    if (s) s.payment_status = "failed";
    return [{ affectedRows: s ? 1 : 0 }];
  }
  if (t.startsWith("select id, status, amount from subscriptions where razorpay_order_id")) {
    return [state.subs.filter((s) => s.razorpay_order_id === p[0] && s.user_id === p[1])];
  }

  throw new Error(`membership test store: unhandled SQL: ${t}`);
};

const connection = { execute: run, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
const pool = { execute: run, getConnection: async () => connection };

const sqlPath = require.resolve(path.join(root, "config", "sql"));
require.cache[sqlPath] = { id: sqlPath, filename: sqlPath, loaded: true, exports: { poolPromise: Promise.resolve(pool) } };

// audit.service writes to the same stub pool; give it a no-op.
const audit = require("../services/audit.service");
audit.record = async () => true;

const razorpay = require("../services/razorpay.service");
razorpay.createOrder = async ({ amountRupees }) => {
  const id = `order_${razorCalls.orders.length + 1}`;
  razorCalls.orders.push({ id, amountRupees });
  return { id, amount: Math.round(amountRupees * 100), currency: "INR" };
};
razorpay.refundPayment = async (paymentId, amount) => {
  razorCalls.refunds.push({ paymentId, amount });
  return { id: "rfnd_1" };
};
razorpay.fetchOrderPayments = async () => paymentsForOrder;

const membership = require("../services/membership.service");

const sign = (orderId, paymentId) =>
  crypto.createHmac("sha256", "unit_secret").update(`${orderId}|${paymentId}`).digest("hex");

const buy = async (userId, slug = "kovenik-member") => {
  const plan = state.plans.find((p) => p.slug === slug);
  return membership.startPurchase({ userId, planId: plan.id });
};
const pay = (userId, order, paymentId) =>
  membership.verifyPurchase({
    userId,
    razorpayOrderId: order.razorpayOrderId,
    razorpayPaymentId: paymentId,
    signature: sign(order.razorpayOrderId, paymentId),
  });
const addTerm = (id, planId, { from = -1, to = 100 } = {}) => {
  const now = Date.now();
  state.subs.push({ id, user_id: USER, plan_id: planId, status: "active", start_date: new Date(now + from * DAY),
    end_date: new Date(now + to * DAY), payment_status: "paid", created_at: new Date(now + from * DAY) });
};

test("plans: customers see only KOVENIK MEMBER, never the retired tiers", async () => {
  reset();
  const plans = await membership.getPublicPlans();
  assert.deepEqual(plans.map((p) => [p.slug, p.name, p.price, p.discountPercent]), [["kovenik-member", "KOVENIK MEMBER", 199, 15]]);
});

test("a retired tier cannot be bought any more", async () => {
  reset();
  await assert.rejects(buy(USER, "gold"), /not available/i);
  await assert.rejects(buy(USER, "bronze"), /not available/i);
  assert.equal(state.subs.length, 0);
});

test("purchase: order amount comes from the plan (Rs 199), payment activates for 365 days", async () => {
  reset();
  const order = await buy(USER);
  assert.equal(order.amount, 19900);
  assert.equal(state.subs[0].status, "pending");

  const result = await pay(USER, order, "pay_1");
  assert.equal(result.outcome, "activated");
  assert.equal(state.subs[0].status, "active");
  assert.equal(state.subs[0].payment_status, "paid");
  assert.equal(Math.round((state.subs[0].end_date - state.subs[0].start_date) / DAY), 365);
});

test("a bad signature never activates and marks the attempt failed", async () => {
  reset();
  const order = await buy(USER);
  await assert.rejects(
    membership.verifyPurchase({ userId: USER, razorpayOrderId: order.razorpayOrderId, razorpayPaymentId: "pay_x", signature: "deadbeef" }),
    /verification failed/i
  );
  assert.equal(state.subs[0].status, "pending");
  assert.equal(state.subs[0].payment_status, "failed");
});

test("another customer cannot settle someone else's order", async () => {
  reset();
  const order = await buy(USER);
  await assert.rejects(pay(OTHER, order, "pay_1"), /does not match/i);
  assert.equal(state.subs[0].status, "pending");
});

test("duplicate attempts: double click reuses the order; double verify activates once", async () => {
  reset();
  const first = await buy(USER);
  const second = await buy(USER);
  assert.equal(second.razorpayOrderId, first.razorpayOrderId);
  assert.equal(razorCalls.orders.length, 1);
  assert.equal(state.subs.length, 1);

  await pay(USER, first, "pay_1");
  const again = await pay(USER, first, "pay_1");
  assert.equal(again.outcome, "already_active");
  assert.equal(state.subs.filter((s) => s.status === "active").length, 1);
});

test("webhook settles a paid order exactly once and checks the amount", async () => {
  reset();
  const order = await buy(USER);
  const wrong = await membership.settleWebhookPayment({ razorpayOrderId: order.razorpayOrderId, paymentId: "pay_1", amountPaise: 100 });
  assert.equal(wrong.reason, "amount_mismatch");
  assert.equal(state.subs[0].status, "pending");

  const ok = await membership.settleWebhookPayment({ razorpayOrderId: order.razorpayOrderId, paymentId: "pay_1", amountPaise: 19900 });
  assert.equal(ok.outcome, "activated");
  const again = await membership.settleWebhookPayment({ razorpayOrderId: order.razorpayOrderId, paymentId: "pay_1", amountPaise: 19900 });
  assert.equal(again.outcome, "already_active");

  const unknown = await membership.settleWebhookPayment({ razorpayOrderId: "order_shop", paymentId: "pay_9", amountPaise: 100 });
  assert.equal(unknown.reason, "unknown_order");
});

test("sync activates when Razorpay says captured (customer closed the tab)", async () => {
  reset();
  const order = await buy(USER);
  paymentsForOrder = [{ id: "pay_7", status: "captured", amount: 19900 }];
  const result = await membership.syncPurchase({ userId: USER, razorpayOrderId: order.razorpayOrderId });
  assert.equal(result.activated, true);
});

test("renewal queues behind the current term; a second renewal is refused", async () => {
  reset();
  await pay(USER, await buy(USER), "pay_1");
  const renewal = await buy(USER);
  assert.equal(renewal.action, "renew");
  await pay(USER, renewal, "pay_2");

  const [current, queued] = state.subs.filter((s) => s.status === "active");
  assert.equal(queued.start_date.getTime(), current.end_date.getTime());
  await assert.rejects(buy(USER), /already renewed/i);
});

test("a customer on an old Gold term renews into KOVENIK MEMBER after it, nothing is cut short", async () => {
  reset();
  addTerm("gold-term", "p-gold", { from: -10, to: 200 });
  const renewal = await buy(USER);
  assert.equal(renewal.action, "renew");
  await pay(USER, renewal, "pay_new");
  const gold = state.subs.find((s) => s.id === "gold-term");
  const member = state.subs.find((s) => s.plan_id === "p-member");
  assert.equal(gold.status, "active");
  assert.equal(member.start_date.getTime(), gold.end_date.getTime());
});

test("a paid order that can no longer be honoured is refunded, not activated", async () => {
  reset();
  // Current term + an already queued renewal; a third paid order must be refunded.
  addTerm("current", "p-member", { from: -1, to: 100 });
  addTerm("queued", "p-member", { from: 100, to: 465 });
  state.subs.push({ id: "extra", user_id: USER, plan_id: "p-member", status: "pending", payment_status: "created",
    razorpay_order_id: "order_x", amount: "199.00", created_at: new Date() });
  const result = await membership.settleWebhookPayment({ razorpayOrderId: "order_x", paymentId: "pay_c", amountPaise: 19900 });
  assert.equal(result.outcome, "refunded");
  assert.deepEqual(razorCalls.refunds, [{ paymentId: "pay_c", amount: "199.00" }]);
  assert.equal(state.subs.find((s) => s.id === "extra").payment_status, "refunded");
});

test("expiry: past-end terms stop counting as current", async () => {
  reset();
  addTerm("old", "p-member", { from: -400, to: -1 });
  assert.equal(await membership.getMemberContext(pool, USER), null);
  addTerm("live", "p-member", { from: -1, to: 100 });
  const ctx = await membership.getMemberContext(pool, USER);
  assert.equal(ctx.planSlug, "kovenik-member");
});

test("pricing: KOVENIK MEMBER gets a flat 15%; guests pay full", async () => {
  const lines = [{ productId: "x", price: 1000, mrp: 1000 }];
  reset();
  addTerm("m", "p-member");
  const priced = await membership.priceLines(pool, USER, lines);
  assert.equal(priced.unitPrices[0], 850);
  assert.equal(priced.member.discountPercent, 15);
  assert.equal(priced.member.freeDelivery, true, "every active member ships free");

  reset();
  const guest = await membership.priceLines(pool, null, lines);
  assert.equal(guest.member, null);
  assert.equal(guest.unitPrices[0], 1000);
});

test("pricing: sale items get the additional 15% on the selling price", async () => {
  reset();
  addTerm("m", "p-member");
  const priced = await membership.priceLines(pool, USER, [
    { productId: "a", price: 900, mrp: 1000 }, // 10% sale -> 765
    { productId: "b", price: 700, mrp: 1000 }, // 30% sale -> 595
    { productId: "c", price: 450, mrp: 1000 }, // 55% sale -> 15% more would break the 60% cap -> 400
  ]);
  assert.deepEqual(priced.unitPrices, [765, 595, 400]);
});

test("old tier terms are honoured as KOVENIK MEMBER: at least 15%, old Gold keeps free shipping", async () => {
  const lines = [{ productId: "x", price: 1000, mrp: 1000 }];
  for (const [plan, free] of [["p-bronze", true], ["p-silver", true], ["p-gold", true]]) {
    reset();
    addTerm("legacy", plan);
    const priced = await membership.priceLines(pool, USER, lines);
    assert.equal(priced.unitPrices[0], 850);
    assert.equal(priced.member.freeDelivery, free);
    assert.equal(priced.member.planName, "KOVENIK MEMBER");
  }
});

test("old tier terms are never made worse if the member plan is not live yet", async () => {
  reset();
  state.plans = state.plans.filter((p) => p.slug !== "kovenik-member");
  addTerm("legacy", "p-gold");
  const priced = await membership.priceLines(pool, USER, [{ productId: "x", price: 1000, mrp: 1000 }]);
  assert.equal(priced.unitPrices[0], 880); // their own 12% until the new plan exists
  assert.equal(priced.member.freeDelivery, true);
});

test("admin product rules: an excluded product keeps its regular price", async () => {
  reset();
  addTerm("m", "p-member");
  state.rules.push({ plan_id: "p-member", product_id: "excluded", eligible: 0, member_price: null });
  state.rules.push({ plan_id: "p-member", product_id: "fixed", eligible: 1, member_price: "700.00" });
  const priced = await membership.priceLines(pool, USER, [
    { productId: "excluded", price: 1000, mrp: 1000 },
    { productId: "fixed", price: 1000, mrp: 1000 },
    { productId: "normal", price: 1000, mrp: 1000 },
  ]);
  assert.deepEqual(priced.unitPrices, [1000, 700, 850]);
});

test("admin cannot create a second plan", async () => {
  reset();
  await assert.rejects(membership.adminSavePlan({ input: { name: "Platinum", slug: "platinum" }, req: {} }), /single membership plan/i);
});
