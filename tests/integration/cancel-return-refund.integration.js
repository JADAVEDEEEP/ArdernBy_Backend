// INTEGRATION TEST: cancellation, return lifecycle and refunds on a REAL MySQL.
//
// Not part of `npm test` (it needs a MySQL server). It drives the real app (routes,
// auth, services, SQL) over HTTP. Only two things are simulated:
//   * the Razorpay HTTP API (create / list refunds, "lost answer", failures, balance)
//   * e-mail sending
// so no real refund is ever made and no real e-mail is ever sent.
//
// Safety: it connects ONLY to a MySQL on this computer (127.0.0.1 / localhost) and
// works in its own database "kv_integration", which it drops and recreates.
//
//   node tests/integration/cancel-return-refund.integration.js
//   (env: KV_TEST_PORT=3399 KV_TEST_USER=root KV_TEST_PASSWORD=)
//
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const assert = require("node:assert/strict");

const HOST = "127.0.0.1";
const PORT = Number(process.env.KV_TEST_PORT || 3399);
const USER = process.env.KV_TEST_USER || "root";
const PASSWORD = process.env.KV_TEST_PASSWORD || "";
const DB = "kv_integration";

process.env.DB_HOST = HOST;
process.env.DB_PORT = String(PORT);
process.env.DB_USER = USER;
process.env.DB_PASSWORD = PASSWORD;
process.env.DB_NAME = DB;
process.env.JWT_SECRET = "integration-secret-only";
process.env.RAZORPAY_KEY_ID = "rzp_test_integration";
process.env.RAZORPAY_KEY_SECRET = "integration_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "integration_webhook_secret";
process.env.BREVO_FROM_EMAIL = "noreply@example.com";
delete process.env.CORS_ORIGINS;

const root = path.join(__dirname, "..", "..");
const mysql = require(path.join(root, "node_modules", "mysql2", "promise"));
const jwt = require(path.join(root, "node_modules", "jsonwebtoken"));

// ---------------------------------------------------------------- simulated Razorpay
const rz = { refunds: [], payments: new Map(), mode: "processed", failNext: null, loseAnswerNext: false, calls: [], seq: 0, balance: 10_000_000 };
const realFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const text = String(url);
  if (!text.startsWith("https://api.razorpay.com/v1")) return realFetch(url, options);
  const apiPath = text.slice("https://api.razorpay.com/v1".length);
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : null;
  rz.calls.push({ method, path: apiPath, body });
  const answer = (status, data) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => data });

  let m = /^\/payments\/([^/]+)\/refunds$/.exec(apiPath);
  if (m && method === "GET" && rz.listFails) throw new TypeError("fetch failed (Razorpay unreachable)");
  if (m && method === "GET") return answer(200, { items: rz.refunds.filter((r) => r.payment_id === m[1]) });

  m = /^\/payments\/([^/]+)\/refund$/.exec(apiPath);
  if (m && method === "POST") {
    if (rz.failNext) {
      const f = rz.failNext;
      rz.failNext = null;
      return answer(f.status, { error: { code: "BAD_REQUEST_ERROR", description: f.description } });
    }
    const payment = rz.payments.get(m[1]);
    if (!payment) return answer(400, { error: { code: "BAD_REQUEST_ERROR", description: "The payment id is invalid" } });
    const already = rz.refunds.filter((r) => r.payment_id === m[1] && r.status !== "failed").reduce((s, r) => s + r.amount, 0);
    if (already + body.amount > payment.amount) {
      return answer(400, { error: { code: "BAD_REQUEST_ERROR", description: "The refund amount provided is greater than the amount captured" } });
    }
    const refund = { id: `rfnd_${++rz.seq}`, payment_id: m[1], amount: body.amount, status: rz.mode, receipt: body.receipt, notes: body.notes };
    rz.refunds.push(refund);
    if (rz.loseAnswerNext) {
      rz.loseAnswerNext = false;
      throw new TypeError("fetch failed (the answer was lost)");
    }
    return answer(200, refund);
  }
  if (apiPath === "/balance") return answer(200, { balance: rz.balance });
  return answer(404, { error: { description: "unexpected " + apiPath } });
};

// ---------------------------------------------------------------- mail
const mails = [];
const mailer = require(path.join(root, "config", "mailer.js"));
mailer.transporter.sendMail = async (m) => {
  mails.push(m);
  return {};
};
const mailsTo = (subjectPart) => mails.filter((m) => m.subject.includes(subjectPart));

// ---------------------------------------------------------------- tiny runner
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push([true, name]);
    console.log("PASS", name);
  } catch (e) {
    results.push([false, name]);
    console.log("FAIL", name, "\n    ", String(e.message).split("\n").slice(0, 8).join("\n     "));
  }
};
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = { c1: uuid(1), c2: uuid(2), admin: uuid(3), owner: uuid(4) };
let db;

const q = async (sql, params = []) => (await db.query(sql, params))[0];
const one = async (sql, params = []) => (await q(sql, params))[0];
const NOW = "UTC_TIMESTAMP(6)";

// ---------------------------------------------------------------- seeding
let orderSeq = 0;
let lineSeq = 100;
const roundMoney = (v) => Math.round(v * 100) / 100;

// lines: [{ variant: 'v1', qty, price }]. Prices follow the real pricing rules.
const makeOrder = async ({ user = ids.c1, method = "online", status = "Processing", payment = "Paid", lines, couponDiscount = 0, deliveredMinutesAgo = 5 }) => {
  orderSeq += 1;
  const id = `ord${orderSeq}`;
  const subtotal = roundMoney(lines.reduce((s, l) => s + l.price * l.qty, 0));
  const discount = Math.min(couponDiscount, subtotal);
  const taxable = roundMoney(subtotal - discount);
  const shipping = subtotal >= 999 ? 0 : 79;
  const tax = Math.round(taxable * 0.05);
  const total = roundMoney(taxable + shipping + tax);
  const paymentId = method === "online" && payment === "Paid" ? `pay_${id}` : null;
  await db.query(
    `INSERT INTO orders (id,user_id,order_number,status,payment_method,payment_status,payment_id,subtotal,shipping_amount,discount_amount,tax_amount,total_amount,shipping_name,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'Test Buyer',${NOW}, DATE_SUB(${NOW}, INTERVAL ? MINUTE))`,
    [id, user, `KV-${id}`, status, method, payment, paymentId, subtotal, shipping, discount, tax, total, deliveredMinutesAgo]
  );
  const itemIds = [];
  for (const line of lines) {
    lineSeq += 1;
    const itemId = uuid(lineSeq);
    itemIds.push(itemId);
    await db.query(
      "INSERT INTO order_items (id, order_id, product_id, variant_id, product_name, size, color, quantity, unit_price) VALUES (?,?,?,?,?,?,?,?,?)",
      [itemId, id, "p1", uuid(line.variant === "v1" ? 11 : 12), line.name || (line.variant === "v1" ? "Tee" : "Cap"), "M", "Black", line.qty, line.price]
    );
  }
  if (paymentId) rz.payments.set(paymentId, { amount: Math.round(total * 100) });
  return { id, itemIds, total, shipping, subtotal, tax, discount, paymentId };
};

const stock = async () => ({
  v1: (await one("SELECT inventory FROM product_variants WHERE id=?", [uuid(11)])).inventory,
  v2: (await one("SELECT inventory FROM product_variants WHERE id=?", [uuid(12)])).inventory,
});
const resetStock = () => db.query("UPDATE product_variants SET inventory = CASE id WHEN ? THEN 10 ELSE 20 END", [uuid(11)]);
const razorpayRefundsFor = (paymentId) => rz.refunds.filter((r) => r.payment_id === paymentId);

// ---------------------------------------------------------------- main
(async () => {
  if (!["127.0.0.1", "localhost"].includes(HOST)) throw new Error("Refusing to run: local MySQL only.");

  const admin = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASSWORD, multipleStatements: true });
  const [[version]] = await admin.query("SELECT VERSION() AS v, @@hostname AS h");
  console.log("MySQL", version.v, "on", HOST + ":" + PORT);
  await admin.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  await admin.end();

  db = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: DB, multipleStatements: true });
  await db.query(fs.readFileSync(path.join(__dirname, "standin-schema.sql"), "utf8"));
  // The real shop tables use utf8mb4_unicode_ci while the tables the migrations create got the server
  // default (utf8mb4_0900_ai_ci). Reproduce that mix so cross-table comparisons are really exercised.
  const shopTables = new Set((await q("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()")).map((r) => r.t));
  for (const file of ["admin_controls_phase1.sql", "admin_controls_phase2_return_items.sql", "admin_controls_phase3_cancel_return_refund.sql"]) {
    await db.query(fs.readFileSync(path.join(root, "scripts", "sql", file), "utf8"));
  }
  for (const row of await q("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'")) {
    if (!shopTables.has(row.t)) await db.query(`ALTER TABLE \`${row.t}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  }
  // repeat the newest migration: it must change nothing
  await db.query(fs.readFileSync(path.join(root, "scripts", "sql", "admin_controls_phase3_cancel_return_refund.sql"), "utf8"));
  await db.query("CREATE TABLE IF NOT EXISTS store_settings (section VARCHAR(40) NOT NULL PRIMARY KEY, value TEXT NOT NULL, updated_by CHAR(36) NULL, updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6))");

  const person = (id, email, role, name) =>
    db.query(`INSERT INTO profiles (id, full_name, email, role, is_active, email_verified, created_at, updated_at) VALUES (?,?,?,?,1,1,${NOW},${NOW})`, [id, name, email, role]);
  await person(ids.c1, "buyer1@example.com", "customer", "Buyer One");
  await person(ids.c2, "buyer2@example.com", "customer", "Buyer Two");
  await person(ids.admin, "admin@example.com", "admin", "Admin One");
  await person(ids.owner, "owner@example.com", "superadmin", "Owner One");
  await db.query(`INSERT INTO products (id, slug, name, price, inventory, created_at, updated_at) VALUES ('p1','tee','Tee',300,0,${NOW},${NOW})`);
  await db.query(`INSERT INTO product_variants (id, product_id, size, color, inventory, created_at, updated_at) VALUES (?,?,?,?,?,${NOW},${NOW}),(?,?,?,?,?,${NOW},${NOW})`,
    [uuid(11), "p1", "M", "Black", 10, uuid(12), "p1", "L", "Black", 20]);
  await db.query(`INSERT INTO store_settings (section, value) VALUES ('returns', '{"enabled":true,"windowDays":7}')`);

  const app = require(path.join(root, "app.js"));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tok = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "2h" });
  const api = async (method, url, { as, body, headers = {}, raw } = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: { ...(body || raw ? { "Content-Type": "application/json" } : {}), ...(as ? { Authorization: `Bearer ${tok(as)}` } : {}), ...headers },
      body: raw || (body ? JSON.stringify(body) : undefined),
    });
    return { status: response.status, json: await response.json().catch(() => ({})) };
  };
  const webhook = async (event, refund) => {
    const raw = JSON.stringify({ event, payload: { refund: { entity: refund } } });
    const signature = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
    return api("POST", "/api/payments/razorpay/webhook", { raw, headers: { "x-razorpay-signature": signature, "x-razorpay-event-id": "evt_" + Math.random() } });
  };
  let accountSeq = 1000;
  const newAccount = async (role) => {
    accountSeq += 1;
    const id = uuid(accountSeq);
    await person(id, `${role}${accountSeq}@example.com`, role, `${role} ${accountSeq}`);
    return id;
  };
  // The endpoints are rate limited per user, so every scenario gets its own people.
  const reset = async () => {
    ids.c1 = await newAccount("customer");
    ids.admin = await newAccount("admin");
    await resetStock();
    rz.mode = "processed";
    rz.failNext = null;
    rz.loseAnswerNext = false;
  };

  const cancelAs = (as, orderId, body) => api("PATCH", `/api/orders/${orderId}/cancel`, { as, body });
  const adminCancel = (orderId, body) => api("POST", `/api/orders/admin/${orderId}/cancel`, { as: ids.admin, body });

  // ======================================================================= CANCELLATION
  await check("migration 3 can be applied twice (guarded ALTERs, IF NOT EXISTS tables)", async () => {
    const cols = await q("SELECT column_name n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='return_requests' AND column_name IN ('reason_code','tracking_reference','refund_method')");
    assert.equal(cols.length, 3);
    const idx = await q("SELECT index_name n FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='return_requests' AND index_name IN ('uq_return_order','ix_return_order')");
    assert.deepEqual(idx.map((r) => r.n), ["ix_return_order"], "the one-return-per-order unique index is replaced");
  });

  await check("cancel needs a reason: missing/unknown reason refused, 'other' needs an explanation", async () => {
    await reset();
    const o = await makeOrder({ method: "cod", payment: "Pending", lines: [{ variant: "v1", qty: 1, price: 500 }] });
    assert.equal((await cancelAs(ids.c1, o.id, {})).status, 400);
    assert.equal((await cancelAs(ids.c1, o.id, { reasonCode: "nonsense" })).status, 400);
    assert.equal((await cancelAs(ids.c1, o.id, { reasonCode: "other" })).status, 400);
    assert.equal((await cancelAs(ids.c1, o.id, { reasonCode: "out_of_stock" })).status, 400, "an admin-only reason is not valid for a customer");
    assert.equal((await one("SELECT status FROM orders WHERE id=?", [o.id])).status, "Processing");
  });

  await check("1. COD order cancelled before dispatch: no refund, stock back once, record + e-mail", async () => {
    await reset();
    const before = await stock();
    const o = await makeOrder({ method: "cod", payment: "Pending", lines: [{ variant: "v1", qty: 2, price: 500 }] });
    await db.query("UPDATE product_variants SET inventory = inventory - 2 WHERE id = ?", [uuid(11)]); // stock the order took
    mails.length = 0;
    const r = await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind", note: "sorry" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.order.status, "Cancelled");
    assert.equal(rz.calls.filter((c) => c.method === "POST").length, 0, "no Razorpay call for COD");
    assert.deepEqual(await stock(), before, "stock restored exactly");
    const c = await one("SELECT * FROM order_cancellations WHERE order_id=?", [o.id]);
    assert.equal(c.refund_status, "not_applicable");
    assert.equal(c.whole_order, 1);
    assert.equal(c.initiated_by, "customer");
    assert.equal(mailsTo("was cancelled").length, 1);
    // again: blocked, nothing changes
    assert.equal((await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind" })).status, 409);
    assert.deepEqual(await stock(), before);
    assert.equal(mailsTo("was cancelled").length, 1);
  });

  await check("2. prepaid order cancelled before dispatch: full refund incl. shipping via Razorpay, keyed, Refunded", async () => {
    await reset();
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 1, price: 300 }, { variant: "v2", qty: 1, price: 200 }] }); // < 999 -> shipping 79
    assert.equal(o.shipping, 79);
    mails.length = 0;
    const r = await cancelAs(ids.c1, o.id, { reasonCode: "found_cheaper" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.message, new RegExp(`₹${o.total.toFixed(2)}`));
    const refunds = razorpayRefundsFor(o.paymentId);
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].amount, Math.round(o.total * 100), "everything incl. shipping, because every item was cancelled");
    assert.match(refunds[0].receipt, /^c[0-9a-f-]{36}$/);
    const c = await one("SELECT refund_status, refund_amount, refund_id FROM order_cancellations WHERE order_id=?", [o.id]);
    assert.deepEqual([c.refund_status, Number(c.refund_amount), c.refund_id], ["completed", o.total, refunds[0].id]);
    const order = await one("SELECT status, payment_status FROM orders WHERE id=?", [o.id]);
    assert.deepEqual([order.status, order.payment_status], ["Cancelled", "Refunded"]);
    assert.equal(mailsTo("is complete").length, 1);
    assert.equal(mailsTo("was cancelled").length, 1);
  });

  await check("3. partial cancellation: refund = the item's share only, one piece restocked, rest of the order kept", async () => {
    await reset();
    const o = await makeOrder({ couponDiscount: 100, lines: [{ variant: "v1", qty: 2, price: 300 }, { variant: "v2", qty: 1, price: 400 }] });
    await db.query("UPDATE product_variants SET inventory = inventory - 2 WHERE id = ?", [uuid(11)]);
    await db.query("UPDATE product_variants SET inventory = inventory - 1 WHERE id = ?", [uuid(12)]);
    const stockBefore = await stock();

    const pre = await api("POST", `/api/orders/${o.id}/cancel-preview`, { as: ids.c1, body: { items: [{ orderItemId: o.itemIds[0], quantity: 1 }] } });
    assert.equal(pre.status, 200, JSON.stringify(pre.json));
    assert.equal(pre.json.amount, 283.5, "300 - 30 discount + 13.50 GST");
    assert.equal(pre.json.wholeOrder, false);

    const r = await cancelAs(ids.c1, o.id, { reasonCode: "wrong_size_ordered", items: [{ orderItemId: o.itemIds[0], quantity: 1 }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.cancellation.wholeOrder, false);
    assert.equal(Number(r.json.cancellation.refundAmount), 283.5);
    const refunds = razorpayRefundsFor(o.paymentId);
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].amount, 28350, "never the whole order");
    const after = await stock();
    assert.equal(after.v1, stockBefore.v1 + 1);
    assert.equal(after.v2, stockBefore.v2, "the other item is untouched");
    const order = await one("SELECT status, payment_status, total_amount FROM orders WHERE id=?", [o.id]);
    assert.deepEqual([order.status, order.payment_status, Number(order.total_amount)], ["Processing", "Partially Refunded", o.total], "the order is not rewritten; only its payment status shows the confirmed partial refund");
    assert.equal((await one("SELECT quantity FROM order_items WHERE id=?", [o.itemIds[0]])).quantity, 2, "order_items untouched");

    // the customer's options now show what is left
    const opts = await api("GET", `/api/orders/${o.id}/cancel-options`, { as: ids.c1 });
    assert.deepEqual(opts.json.items.map((i) => [i.quantity, i.cancelledQuantity, i.availableQuantity]), [[2, 1, 1], [1, 0, 1]]);

    // too many / already-cancelled units are refused
    assert.equal((await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind", items: [{ orderItemId: o.itemIds[0], quantity: 2 }] })).status, 409);

    // cancel the rest: shipping is refunded now (the whole order is cancelled)
    const rest = await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind" });
    assert.equal(rest.status, 200, JSON.stringify(rest.json));
    assert.equal(rest.json.cancellation.wholeOrder, true);
    const all = razorpayRefundsFor(o.paymentId);
    assert.equal(all.length, 2);
    assert.equal(all.reduce((s, x) => s + x.amount, 0), Math.round(o.total * 100), "the two refunds add up to exactly what was paid");
    assert.deepEqual(await stock(), { v1: stockBefore.v1 + 2, v2: stockBefore.v2 + 1 });
    const done = await one("SELECT status, payment_status FROM orders WHERE id=?", [o.id]);
    assert.deepEqual([done.status, done.payment_status], ["Cancelled", "Refunded"]);
    assert.equal((await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind" })).status, 409);
  });

  await check("4. cancellation after dispatch is blocked on the server (shipped, delivered); Packed is admin-only", async () => {
    await reset();
    const shipped = await makeOrder({ status: "Shipped", lines: [{ variant: "v1", qty: 1, price: 1200 }] });
    const delivered = await makeOrder({ status: "Delivered", lines: [{ variant: "v1", qty: 1, price: 1200 }] });
    const packed = await makeOrder({ status: "Packed", lines: [{ variant: "v1", qty: 1, price: 1200 }] });
    for (const o of [shipped, delivered]) {
      const r = await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind" });
      assert.equal(r.status, 409);
      assert.match(r.json.message, /return/i, "points the customer to returns");
      assert.equal((await adminCancel(o.id, { reasonCode: "customer_request" })).status, 409, "admins cannot cancel a shipped/delivered order either");
    }
    assert.equal((await cancelAs(ids.c1, packed.id, { reasonCode: "changed_mind" })).status, 409, "customers cannot cancel a packed order");
    assert.equal((await adminCancel(packed.id, { reasonCode: "customer_request" })).status, 200, "an admin can, before dispatch");
    assert.equal(razorpayRefundsFor(packed.paymentId).length, 1);
    // someone else's order looks missing
    const mine = await makeOrder({ user: ids.c2, method: "cod", payment: "Pending", lines: [{ variant: "v1", qty: 1, price: 500 }] });
    assert.equal((await cancelAs(ids.c1, mine.id, { reasonCode: "changed_mind" })).status, 404);
  });

  await check("admin cancel: reason mandatory, audited with who/why, customer e-mailed; plain status-box cancel needs it too", async () => {
    await reset();
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 1, price: 1500 }] });
    assert.equal((await adminCancel(o.id, {})).status, 400);
    assert.equal((await api("PATCH", `/api/orders/admin/${o.id}/status`, { as: ids.admin, body: { status: "Cancelled" } })).status, 400, "the old status box cannot skip the reason");
    mails.length = 0;
    const r = await api("PATCH", `/api/orders/admin/${o.id}/status`, { as: ids.admin, body: { status: "Cancelled", reasonCode: "out_of_stock" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const audit = await one("SELECT * FROM audit_logs WHERE action='order.cancel' AND resource_id=? ORDER BY created_at DESC LIMIT 1", [o.id]);
    assert.equal(audit.actor_id, ids.admin);
    assert.match(audit.reason, /out_of_stock/);
    const c = await one("SELECT initiated_by, actor_id FROM order_cancellations WHERE order_id=?", [o.id]);
    assert.deepEqual([c.initiated_by, c.actor_id], ["admin", ids.admin]);
    assert.equal(mailsTo("was cancelled").length, 1);
    assert.equal((await api("POST", `/api/orders/admin/${o.id}/cancel`, { as: ids.c1, body: { reasonCode: "out_of_stock" } })).status, 403);
  });

  await check("7/8. refund accepted but pending -> 'processing' (never 'completed'); signed webhook completes it once; repeats change nothing", async () => {
    await reset();
    rz.mode = "pending";
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 1, price: 1500 }] });
    mails.length = 0;
    await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind" });
    const c = await one("SELECT id, refund_status, refund_id FROM order_cancellations WHERE order_id=?", [o.id]);
    assert.equal(c.refund_status, "processing", "accepting the API call is not completion");
    assert.equal((await one("SELECT payment_status FROM orders WHERE id=?", [o.id])).payment_status, "Refund Pending");
    assert.equal(mailsTo("has started").length, 1);
    assert.equal(mailsTo("is complete").length, 0);

    // bad signature is refused
    const bad = await api("POST", "/api/payments/razorpay/webhook", { raw: JSON.stringify({ event: "refund.processed" }), headers: { "x-razorpay-signature": "nope" } });
    assert.equal(bad.status, 400);

    const hook = { id: c.refund_id, receipt: rz.refunds.at(-1).receipt, status: "processed" };
    const first = await webhook("refund.processed", hook);
    assert.equal(first.status, 200);
    assert.deepEqual([first.json.matched, first.json.changed], [true, true]);
    assert.equal((await one("SELECT refund_status FROM order_cancellations WHERE id=?", [c.id])).refund_status, "completed");
    assert.equal((await one("SELECT payment_status FROM orders WHERE id=?", [o.id])).payment_status, "Refunded");
    assert.equal(mailsTo("is complete").length, 1);

    const again = await webhook("refund.processed", hook);
    assert.deepEqual([again.json.matched, again.json.changed], [true, false]);
    assert.equal(mailsTo("is complete").length, 1, "no duplicate e-mail");
    // a 'failed' event for an already completed refund cannot undo it
    await webhook("refund.failed", { ...hook, status: "failed" });
    assert.equal((await one("SELECT refund_status FROM order_cancellations WHERE id=?", [c.id])).refund_status, "completed");
    // an event that is not ours is ignored
    assert.equal((await webhook("refund.processed", { id: "rfnd_unknown", receipt: "x", status: "processed" })).json.matched, false);
  });

  await check("9. Razorpay refuses the refund -> 'failed' (order still cancelled); safe retry creates exactly ONE refund", async () => {
    await reset();
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 1, price: 1500 }] });
    rz.failNext = { status: 400, description: "Your account does not have enough balance to carry out the refund operation." };
    mails.length = 0;
    await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind" });
    const c = await one("SELECT id, refund_status, refund_error FROM order_cancellations WHERE order_id=?", [o.id]);
    assert.equal(c.refund_status, "failed");
    assert.ok(c.refund_error);
    assert.equal(razorpayRefundsFor(o.paymentId).length, 0);
    assert.equal(mailsTo("fixing your refund").length, 1);
    assert.equal((await one("SELECT status FROM orders WHERE id=?", [o.id])).status, "Cancelled", "the cancellation itself stands");

    // retry through the admin button that already existed
    const retry = await api("PATCH", `/api/orders/admin/${o.id}/retry-refund`, { as: ids.admin });
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(razorpayRefundsFor(o.paymentId).length, 1);
    assert.equal((await one("SELECT refund_status FROM order_cancellations WHERE id=?", [c.id])).refund_status, "completed");
    assert.equal((await one("SELECT payment_status FROM orders WHERE id=?", [o.id])).payment_status, "Refunded");
    // nothing left to retry
    const again = await api("PATCH", `/api/orders/admin/${o.id}/retry-refund`, { as: ids.admin });
    assert.notEqual(again.status, 500);
    assert.equal(razorpayRefundsFor(o.paymentId).length, 1, "still exactly one refund");
  });

  await check("17. duplicate refund blocked: Razorpay created the refund but the answer was lost -> retry ADOPTS it (by receipt)", async () => {
    await reset();
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 1, price: 1500 }] });
    rz.loseAnswerNext = true;
    await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind" });
    const c = await one("SELECT id, refund_status, refund_id FROM order_cancellations WHERE order_id=?", [o.id]);
    assert.equal(c.refund_status, "processing", "unknown outcome is never 'completed' nor 'failed'");
    assert.equal(razorpayRefundsFor(o.paymentId).length, 1, "Razorpay did create it");
    // it is a fresh attempt with no refund id: a retry right now would race, so it waits
    const early = await api("PATCH", `/api/orders/admin/${o.id}/retry-refund`, { as: ids.admin });
    assert.equal(early.status, 409);
    await db.query("UPDATE order_cancellations SET updated_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 5 MINUTE) WHERE id = ?", [c.id]);
    const retry = await api("PATCH", `/api/orders/admin/${o.id}/retry-refund`, { as: ids.admin });
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(razorpayRefundsFor(o.paymentId).length, 1, "adopted, not duplicated");
    assert.equal((await one("SELECT refund_status, refund_id FROM order_cancellations WHERE id=?", [c.id])).refund_status, "completed");
  });

  await check("concurrency: simultaneous cancels of the same units -> one wins, stock and refund exactly once", async () => {
    await reset();
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 2, price: 800 }] });
    await db.query("UPDATE product_variants SET inventory = inventory - 2 WHERE id = ?", [uuid(11)]);
    const before = await stock();
    const results = await Promise.all([1, 2, 3, 4].map(() => cancelAs(ids.c1, o.id, { reasonCode: "changed_mind" })));
    const wins = results.filter((r) => r.status === 200).length;
    assert.equal(wins, 1, results.map((r) => r.status).join(","));
    assert.equal(razorpayRefundsFor(o.paymentId).length, 1);
    assert.equal((await stock()).v1, before.v1 + 2, "restocked once");
    assert.equal((await q("SELECT id FROM order_cancellations WHERE order_id=?", [o.id])).length, 1);
    assert.equal((await q("SELECT id FROM inventory_movements WHERE reference_type='cancellation'")).filter(Boolean).length >= 1, true);
  });

  await check("concurrency: two refund retries at once -> a single Razorpay refund", async () => {
    await reset();
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 1, price: 1500 }] });
    rz.failNext = { status: 500, description: "Razorpay is down" };
    await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind" });
    const c = await one("SELECT refund_status FROM order_cancellations WHERE order_id=?", [o.id]);
    assert.equal(c.refund_status, "failed");
    const both = await Promise.all([1, 2, 3].map(() => api("PATCH", `/api/orders/admin/${o.id}/retry-refund`, { as: ids.admin })));
    assert.equal(razorpayRefundsFor(o.paymentId).length, 1, both.map((r) => r.status).join(","));
    assert.equal((await one("SELECT refund_status FROM order_cancellations WHERE order_id=?", [o.id])).refund_status, "completed");
  });

  await check("a refund can never exceed what was paid (Razorpay would also refuse)", async () => {
    await reset();
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 2, price: 800 }] });
    // pretend part of the payment was already refunded outside this engine
    await db.query("INSERT INTO order_cancellations (id, order_id, user_id, initiated_by, reason_code, whole_order, refund_amount, refund_status, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?,?,?)",
      [uuid(900), o.id, ids.c1, "admin", "other", o.total - 100, "completed", new Date(), new Date()]);
    const r = await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind" });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.code, "EXCEEDS_PAID");
    assert.equal(razorpayRefundsFor(o.paymentId).length, 0);
  });

  // ======================================================================= RETURNS
  const returnDelivered = (over = {}) => makeOrder({ status: "Delivered", ...over });
  const requestReturn = (as, orderId, items, extra = {}) =>
    api("POST", "/api/returns", { as, body: { orderId, reasonCode: "wrong_size", description: "It is too small for me", items, ...extra } });
  const adminReturn = (id) => api("GET", `/api/admin/returns/${id}`, { as: ids.admin });
  const step = (id, action, body = {}) => {
    const map = {
      approve: ["PATCH", `/api/admin/returns/${id}/decision`, { decision: "approve", reason: "Photos confirm the size issue", ...body }],
      reject: ["PATCH", `/api/admin/returns/${id}/decision`, { decision: "reject", reason: "Worn and washed", ...body }],
      shipped: ["PATCH", `/api/admin/returns/${id}/shipped`, body],
      received: ["PATCH", `/api/admin/returns/${id}/receive`, body],
      inspect: ["PATCH", `/api/admin/returns/${id}/inspect`, body],
      refund: ["POST", `/api/admin/returns/${id}/refund`, body],
      retry: ["POST", `/api/admin/returns/${id}/refund-retry`, body],
    }[action];
    return api(map[0], map[1], { as: ids.admin, body: map[2] });
  };
  const okInspection = (orderItemId, over = {}) => ({ orderItemId, result: "unused_original", refundable: true, note: "", ...over });

  await check("5/6. return request: reason code + items + quantities; partial of one item; window and duplicate-unit rules enforced on the server", async () => {
    await reset();
    const o = await returnDelivered({ lines: [{ variant: "v1", qty: 2, price: 300 }, { variant: "v2", qty: 1, price: 700 }] });
    const old = await returnDelivered({ lines: [{ variant: "v1", qty: 1, price: 800 }], deliveredMinutesAgo: 60 * 24 * 10 });
    const shipped = await makeOrder({ status: "Shipped", lines: [{ variant: "v1", qty: 1, price: 800 }] });

    assert.equal((await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }], { reasonCode: undefined })).status, 400, "a reason is required");
    assert.equal((await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }], { reasonCode: "other", description: "" })).status, 400);
    assert.equal((await requestReturn(ids.c1, o.id, [])).status, 400);
    assert.equal((await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 3 }])).status, 409, "more than bought");
    assert.equal((await requestReturn(ids.c2, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }])).status, 404, "not their order");
    assert.equal((await requestReturn(ids.c1, old.id, [{ orderItemId: old.itemIds[0], quantity: 1 }])).json.code, "WINDOW_ENDED");
    assert.equal((await requestReturn(ids.c1, shipped.id, [{ orderItemId: shipped.itemIds[0], quantity: 1 }])).json.code, "NOT_DELIVERED");

    const est = await api("POST", "/api/returns/preview", { as: ids.c1, body: { orderId: o.id, items: [{ orderItemId: o.itemIds[0], quantity: 1 }] } });
    assert.equal(est.status, 200, JSON.stringify(est.json));
    assert.ok(est.json.estimate > 0 && est.json.estimate < o.total, "an estimate for ONE item, not the whole order");

    const first = await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }]);
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal((await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 2 }])).json.code, "QUANTITY_UNAVAILABLE", "one of the two is already in a request");
    const second = await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }, { orderItemId: o.itemIds[1], quantity: 1 }], { reasonCode: "damaged" });
    assert.equal(second.status, 201, "the remaining units can go in a second request");
    assert.equal((await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[1], quantity: 1 }])).status, 409, "now everything is claimed");
    const view = await api("GET", `/api/returns/order/${o.id}`, { as: ids.c1 });
    assert.equal(view.json.requests.length, 2);
    assert.equal(view.json.eligible, false);
    assert.equal(view.json.reason, "ALL_REQUESTED");
    assert.equal(mailsTo("received your return request").length >= 2, true);
    const hist = await q("SELECT to_status FROM return_status_history WHERE return_id=?", [first.json.return.id]);
    assert.deepEqual(hist.map((h) => h.to_status), ["Requested"]);
  });

  await check("concurrency: simultaneous return requests for the same unit -> exactly one is saved", async () => {
    await reset();
    const o = await returnDelivered({ lines: [{ variant: "v1", qty: 1, price: 800 }] });
    const results = await Promise.all([1, 2, 3, 4].map(() => requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }])));
    assert.equal(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join(","));
    assert.equal((await q("SELECT id FROM return_requests WHERE order_id=?", [o.id])).length, 1);
    assert.equal((await q("SELECT id FROM return_request_items WHERE return_id IN (SELECT id FROM return_requests WHERE order_id=?)", [o.id])).length, 1);
  });

  await check("8. lifecycle: invalid jumps are blocked; every step is recorded with who and when; stock/refund wait for inspection", async () => {
    await reset();
    const o = await returnDelivered({ method: "online", lines: [{ variant: "v1", qty: 1, price: 1200 }] });
    const before = await stock();
    const made = await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }]);
    const id = made.json.return.id;
    const item = o.itemIds[0];

    for (const bad of ["shipped", "received", "inspect", "refund"]) {
      const r = await step(id, bad, bad === "inspect" ? { inspections: [okInspection(item)] } : {});
      assert.equal(r.status, 409, `${bad} before approval -> ${r.status}`);
    }
    assert.equal((await step(id, "approve", { reason: "x" })).status, 400, "a reason is required");
    assert.equal((await step(id, "approve")).status, 200);
    assert.equal((await step(id, "approve")).status, 409, "cannot approve twice");
    assert.equal((await step(id, "reject")).status, 409, "cannot reject after approving");
    assert.equal((await step(id, "inspect", { inspections: [okInspection(item)] })).status, 409, "cannot inspect before it is received");
    assert.equal((await step(id, "refund")).status, 409, "cannot refund before inspection");

    // the customer says it is on its way (their own request only)
    assert.equal((await api("PATCH", `/api/returns/${id}/shipped`, { as: ids.c2, body: {} })).status, 404);
    const ship = await api("PATCH", `/api/returns/${id}/shipped`, { as: ids.c1, body: { trackingReference: "TRK12345" } });
    assert.equal(ship.status, 200, JSON.stringify(ship.json));
    assert.equal((await api("PATCH", `/api/returns/${id}/shipped`, { as: ids.c1, body: {} })).status, 409, "only once");

    const got = await step(id, "received", { note: "Parcel arrived intact" });
    assert.equal(got.status, 200);
    assert.deepEqual(await stock(), before, "receiving does NOT restock");
    assert.equal(razorpayRefundsFor(o.paymentId).length, 0, "receiving does NOT refund");
    assert.equal((await adminReturn(id)).json.return.status, "Received");

    const hist = await q("SELECT from_status, to_status, actor_role FROM return_status_history WHERE return_id=? ORDER BY created_at, id", [id]);
    assert.deepEqual(hist.map((h) => h.to_status), ["Requested", "Approved", "Shipped", "Received"]);
    assert.deepEqual(hist.map((h) => h.actor_role), ["customer", "admin", "customer", "admin"]);
    const detail = (await adminReturn(id)).json.return;
    assert.equal(detail.trackingReference, "TRK12345");
    assert.equal(detail.history.length, 4);
  });

  await check("10/11/12/13/14. inspection: unused item restocked ONCE, damaged one is not; refund only for refundable items, exact share, online via Razorpay", async () => {
    await reset();
    const o = await returnDelivered({ method: "online", couponDiscount: 100, lines: [{ variant: "v1", qty: 2, price: 300 }, { variant: "v2", qty: 1, price: 700 }] });
    const before = await stock();
    const made = await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 2 }, { orderItemId: o.itemIds[1], quantity: 1 }], { reasonCode: "damaged" });
    const id = made.json.return.id;
    await step(id, "approve");
    await step(id, "received");

    // every item must be inspected; unused needs no note; damaged needs one
    assert.equal((await step(id, "inspect", { inspections: [okInspection(o.itemIds[0])] })).status, 400, "incomplete");
    assert.equal((await step(id, "inspect", { inspections: [okInspection(o.itemIds[0]), okInspection(o.itemIds[1], { result: "damaged", refundable: true })] })).status, 400, "note needed");
    assert.equal((await step(id, "inspect", { inspections: [okInspection(o.itemIds[0]), okInspection(o.itemIds[1], { result: "damaged", note: "Torn seam", refundable: true, restock: true })] })).json.code, "RESTOCK_NOT_AUTHORIZED");
    assert.equal((await step(id, "inspect", { inspections: [okInspection(o.itemIds[0]), okInspection(o.itemIds[1], { result: "incorrect_item", note: "Not ours", refundable: false, restock: true, authorizeRestock: true })] })).status, 400, "an item that is not ours can never be restocked");
    assert.deepEqual(await stock(), before, "refused attempts changed nothing");

    const done = await step(id, "inspect", { inspections: [okInspection(o.itemIds[0]), okInspection(o.itemIds[1], { result: "damaged", note: "Torn seam", refundable: true })] });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    const after = await stock();
    assert.equal(after.v1, before.v1 + 2, "the unused tees are back in stock");
    assert.equal(after.v2, before.v2, "the damaged cap is NOT restocked");
    assert.equal((await step(id, "inspect", { inspections: [okInspection(o.itemIds[0]), okInspection(o.itemIds[1], { result: "damaged", note: "Torn seam", refundable: true })] })).status, 409, "inspecting twice is refused");
    assert.deepEqual(await stock(), after, "stock restored exactly once");
    assert.equal((await q("SELECT id FROM inventory_movements WHERE reference_id=? AND source='return_received'", [id])).length, 1);

    // the server shows the breakdown before anything is paid
    const pre = (await adminReturn(id)).json.return;
    assert.equal(pre.status, "Inspected");
    assert.ok(pre.refundPreview && pre.refundPreview.lines.length === 2);
    const sum = (key) => Math.round(pre.refundPreview.lines.reduce((s, l) => s + l[key], 0) * 100) / 100;
    assert.equal(sum("goods"), 1300, "gross price of the returned items");
    assert.equal(sum("discount"), 100, "their share of the coupon");
    assert.equal(sum("tax"), 60, "their share of GST");
    assert.equal(pre.refundPreview.shipping, 0, "shipping is not refunded on a return");
    assert.equal(pre.refundPreview.final, 1260, "1300 - 100 + 60");

    // a deduction needs a reason and can only reduce
    assert.equal((await step(id, "refund", { deduction: 50 })).status, 400);
    assert.equal((await step(id, "refund", { deduction: 5000, deductionReason: "Return pickup fee" })).status, 400);
    const paid = await step(id, "refund", { deduction: 60, deductionReason: "Damage to the cap" , amount: 999999 /* ignored */ });
    assert.equal(paid.status, 200, JSON.stringify(paid.json));
    assert.equal(paid.json.return.amount, 1200, "1260 calculated - 60 deduction; the amount the browser sent is ignored");
    const refunds = razorpayRefundsFor(o.paymentId);
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].amount, 120000);
    assert.match(refunds[0].receipt, /^r[0-9a-f-]{36}$/);
    const final = (await adminReturn(id)).json.return;
    assert.equal(final.status, "Completed");
    assert.equal(final.refund.status, "completed");
    assert.equal(final.refund.calculated, 1260);
    assert.equal(final.refund.deduction, 60);
    assert.equal(final.refund.method, "razorpay");
    assert.equal((await one("SELECT status FROM orders WHERE id=?", [o.id])).status, "Returned", "every unit came back");

    // 16. no double refund on a repeated click, even with a refund id lost
    const dup = await step(id, "refund", {});
    assert.equal(dup.status, 409);
    assert.equal(razorpayRefundsFor(o.paymentId).length, 1);
    const hist = (await q("SELECT to_status FROM return_status_history WHERE return_id=? AND from_status IS NOT NULL ORDER BY created_at, id", [id])).map((h) => h.to_status);
    assert.deepEqual(hist.filter((h) => h !== "Inspected" || true).slice(0, 4), ["Approved", "Received", "Inspected", "Inspected"]);
    assert.equal(hist.at(-1), "Completed");
    assert.equal(mailsTo("is complete").length >= 1, true);
  });

  await check("14. full refund of a whole return = every unit's price - discount + GST (no shipping on returns); the order total is never exceeded", async () => {
    await reset();
    const o = await returnDelivered({ method: "online", lines: [{ variant: "v1", qty: 1, price: 600 }, { variant: "v2", qty: 1, price: 600 }] });
    const made = await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }, { orderItemId: o.itemIds[1], quantity: 1 }]);
    const id = made.json.return.id;
    await step(id, "approve");
    await step(id, "received");
    await step(id, "inspect", { inspections: o.itemIds.map((i) => okInspection(i)) });
    const r = await step(id, "refund", {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.return.amount, 1260, "1200 + 60 GST");
    assert.ok(r.json.return.amount <= o.total);
  });

  await check("15. return refund refused by Razorpay -> failed, the return stays 'Inspected' (not Completed); retry pays once; webhook is idempotent", async () => {
    await reset();
    const o = await returnDelivered({ method: "online", lines: [{ variant: "v1", qty: 1, price: 1500 }] });
    const id = (await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }])).json.return.id;
    await step(id, "approve");
    await step(id, "received");
    await step(id, "inspect", { inspections: [okInspection(o.itemIds[0])] });
    rz.failNext = { status: 400, description: "Your account does not have enough balance to carry out the refund operation." };
    mails.length = 0;
    const paid = await step(id, "refund", {});
    assert.equal(paid.status, 200);
    let r = (await adminReturn(id)).json.return;
    assert.deepEqual([r.status, r.refund.status], ["Inspected", "failed"], "not completed before the refund is");
    assert.ok(r.refund.error);
    assert.equal(razorpayRefundsFor(o.paymentId).length, 0);
    assert.equal(mailsTo("fixing your return refund").length, 1);
    // the customer never sees 'failed'
    const view = await api("GET", `/api/returns/order/${o.id}`, { as: ids.c1 });
    assert.equal(view.json.request.refund.state, "in_progress");
    assert.ok(!/failed|razorpay|error/i.test(JSON.stringify(view.json.request)));

    rz.mode = "pending";
    const retry = await step(id, "retry");
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    r = (await adminReturn(id)).json.return;
    assert.deepEqual([r.status, r.refund.status], ["Inspected", "processing"], "accepted is not completed");
    assert.equal(razorpayRefundsFor(o.paymentId).length, 1);
    assert.equal((await Promise.all([step(id, "retry"), step(id, "retry")])).filter(Boolean).length, 2);
    assert.equal(razorpayRefundsFor(o.paymentId).length, 1, "concurrent retries do not create another refund");

    const refund = razorpayRefundsFor(o.paymentId)[0];
    const hook = { id: refund.id, receipt: refund.receipt, status: "processed" };
    assert.equal((await webhook("refund.processed", hook)).json.changed, true);
    assert.equal((await webhook("refund.processed", hook)).json.changed, false);
    r = (await adminReturn(id)).json.return;
    assert.deepEqual([r.status, r.refund.status], ["Completed", "completed"]);
    assert.equal(mailsTo("return refund for order").filter((m) => m.subject.includes("is complete")).length, 1);
  });

  await check("16. COD return: no Razorpay call; manual refund needs a method + reference and records who/how; completes the return", async () => {
    await reset();
    const o = await returnDelivered({ method: "cod", payment: "Paid", lines: [{ variant: "v1", qty: 1, price: 1500 }] });
    const id = (await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }])).json.return.id;
    await step(id, "approve");
    await step(id, "received");
    await step(id, "inspect", { inspections: [okInspection(o.itemIds[0])] });
    const callsBefore = rz.calls.length;
    assert.equal((await step(id, "refund", {})).status, 400, "method required");
    assert.equal((await step(id, "refund", { method: "paypal", reference: "abc123" })).status, 400);
    assert.equal((await step(id, "refund", { method: "upi", reference: "ab" })).status, 400, "reference required");
    const ok = await step(id, "refund", { method: "upi", reference: "UPI 4455667788" });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(rz.calls.length, callsBefore, "no Razorpay call for cash on delivery");
    const r = (await adminReturn(id)).json.return;
    assert.deepEqual([r.status, r.refund.status, r.refund.method, r.refund.reference], ["Completed", "completed", "upi", "UPI 4455667788"]);
    const who = await one("SELECT refund_processed_by, refund_amount FROM return_requests WHERE id=?", [id]);
    assert.equal(who.refund_processed_by, ids.admin);
    assert.equal(Number(who.refund_amount), 1575);
    assert.equal((await step(id, "refund", { method: "upi", reference: "UPI again" })).status, 409, "no second manual refund");
  });

  await check("a return where nothing is refundable finishes without any refund; the customer is told", async () => {
    await reset();
    const o = await returnDelivered({ method: "online", lines: [{ variant: "v1", qty: 1, price: 1500 }] });
    const before = await stock();
    const id = (await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }], { reasonCode: "wrong_product" })).json.return.id;
    await step(id, "approve");
    await step(id, "received");
    mails.length = 0;
    const r = await step(id, "inspect", { inspections: [okInspection(o.itemIds[0], { result: "used_washed", note: "Washed, tags removed", refundable: false })] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.return.status, "Completed");
    assert.equal(razorpayRefundsFor(o.paymentId).length, 0);
    assert.deepEqual(await stock(), before, "used/washed goods are not restocked");
    assert.equal(mailsTo("finished checking").length, 1);
    const order = await one("SELECT status, payment_status FROM orders WHERE id=?", [o.id]);
    assert.deepEqual([order.status, order.payment_status], ["Returned", "Paid"], "the goods did come back, but no money moved");
  });

  await check("rejection: reason mandatory, customer sees only the reason; nothing changes; units are free again", async () => {
    await reset();
    const o = await returnDelivered({ method: "cod", payment: "Paid", lines: [{ variant: "v1", qty: 1, price: 1500 }] });
    const before = await stock();
    const id = (await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }])).json.return.id;
    mails.length = 0;
    assert.equal((await step(id, "reject", { reason: "no" })).status, 400);
    assert.equal((await step(id, "reject")).status, 200);
    assert.equal(mailsTo("About your return request").length, 1);
    assert.match(mailsTo("About your return request")[0].text, /Worn and washed/);
    assert.deepEqual(await stock(), before);
    const view = await api("GET", `/api/returns/order/${o.id}`, { as: ids.c1 });
    assert.equal(view.json.request.customerStatus, "Rejected");
    assert.equal(view.json.eligible, true, "a rejected request frees the units for a new request");
    assert.equal((await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }])).status, 201);
  });

  await check("returned + cancelled units share one budget: a line cannot be cancelled and returned beyond what was bought", async () => {
    await reset();
    const o = await makeOrder({ status: "Processing", lines: [{ variant: "v1", qty: 2, price: 800 }] });
    await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind", items: [{ orderItemId: o.itemIds[0], quantity: 1 }] });
    await db.query("UPDATE orders SET status='Delivered', updated_at = UTC_TIMESTAMP(6) WHERE id=?", [o.id]); // pretend it shipped and arrived
    assert.equal((await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 2 }])).status, 409, "one unit was cancelled");
    const r = await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }]);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    // total refunded for the line can never pass its price
    const id = r.json.return.id;
    await step(id, "approve");
    await step(id, "received");
    await step(id, "inspect", { inspections: [okInspection(o.itemIds[0])] });
    const paid = await step(id, "refund", {});
    assert.equal(paid.status, 200, JSON.stringify(paid.json));
    const totalRefunded = rz.refunds.filter((x) => x.payment_id === o.paymentId).reduce((s, x) => s + x.amount, 0);
    assert.ok(totalRefunded <= Math.round(o.total * 100) - Math.round(o.shipping * 100), "never more than the goods");
  });

  // ======================================================================= PARTIAL REFUNDS, DELIVERY WINDOW, LEGACY FLOW, TRANSITIONS
  const payStatus = async (id) => (await one("SELECT status, payment_status FROM orders WHERE id=?", [id]));
  const finishReturnFor = async (id, itemIds, { deduction } = {}) => {
    assert.equal((await step(id, "approve")).status, 200);
    assert.equal((await step(id, "received")).status, 200);
    const done = await step(id, "inspect", { inspections: itemIds.map((i) => okInspection(i)) });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    return step(id, "refund", deduction ? { deduction, deductionReason: "Pickup fee" } : {});
  };

  await check("A1. partial cancel -> Partially Refunded; a second partial and the final cancel still refund; the refunds add up to exactly what was paid", async () => {
    await reset();
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 3, price: 300 }, { variant: "v2", qty: 1, price: 200 }] });
    const first = await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind", items: [{ orderItemId: o.itemIds[0], quantity: 1 }] });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.deepEqual(Object.values(await payStatus(o.id)), ["Processing", "Partially Refunded"], "money partly back, order still open");

    // the order is still 'held' money: a second refund must be accepted
    const second = await adminCancel(o.id, { reasonCode: "out_of_stock", items: [{ orderItemId: o.itemIds[0], quantity: 1 }] });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal((await payStatus(o.id)).payment_status, "Partially Refunded");

    const last = await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind" });
    assert.equal(last.status, 200, JSON.stringify(last.json));
    assert.deepEqual(Object.values(await payStatus(o.id)), ["Cancelled", "Refunded"]);
    const refunds = razorpayRefundsFor(o.paymentId);
    assert.equal(refunds.length, 3);
    assert.equal(refunds.reduce((s, r) => s + r.amount, 0), Math.round(o.total * 100), "exactly what was paid, never more");
    assert.equal(new Set(refunds.map((r) => r.receipt)).size, 3);
  });

  await check("A2. a refund Razorpay has only accepted does not change the status; the webhook confirming it does", async () => {
    await reset();
    rz.mode = "pending";
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 2, price: 600 }] });
    const r = await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind", items: [{ orderItemId: o.itemIds[0], quantity: 1 }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await payStatus(o.id)).payment_status, "Paid", "accepted is not refunded");
    const refund = razorpayRefundsFor(o.paymentId)[0];
    assert.equal((await webhook("refund.processed", { id: refund.id, receipt: refund.receipt, status: "processed" })).json.changed, true);
    assert.equal((await payStatus(o.id)).payment_status, "Partially Refunded");
    assert.equal((await webhook("refund.processed", { id: refund.id, receipt: refund.receipt, status: "processed" })).json.changed, false);
    assert.equal((await payStatus(o.id)).payment_status, "Partially Refunded");
    rz.mode = "processed";
  });

  await check("A3. two partial returns on one order: both refund (status Partially Refunded, shipping kept), then the order is Returned", async () => {
    await reset();
    const o = await returnDelivered({ lines: [{ variant: "v1", qty: 1, price: 300 }, { variant: "v2", qty: 1, price: 400 }] });
    const a = await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }]);
    const b = await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[1], quantity: 1 }]);
    assert.equal((await finishReturnFor(a.json.return.id, [o.itemIds[0]])).status, 200);
    assert.deepEqual(Object.values(await payStatus(o.id)), ["Delivered", "Partially Refunded"]);
    assert.equal((await finishReturnFor(b.json.return.id, [o.itemIds[1]])).status, 200, "a second return refund is accepted after the first");
    assert.deepEqual(Object.values(await payStatus(o.id)), ["Returned", "Partially Refunded"], "shipping was not refunded, so it is not fully refunded");
    const refunds = razorpayRefundsFor(o.paymentId);
    assert.equal(refunds.length, 2);
    assert.ok(refunds.reduce((s, r) => s + r.amount, 0) <= Math.round(o.total * 100));
  });

  await check("A4. COD returns: each manual payout shows Partially Refunded; when everything collected is paid back the order is Refunded and Returned", async () => {
    await reset();
    const cod = await returnDelivered({ method: "cod", payment: "Paid", lines: [{ variant: "v1", qty: 1, price: 900 }, { variant: "v2", qty: 1, price: 200 }] });
    const r = await requestReturn(ids.c1, cod.id, [{ orderItemId: cod.itemIds[0], quantity: 1 }]);
    const id = r.json.return.id;
    assert.equal((await step(id, "approve")).status, 200);
    assert.equal((await step(id, "received")).status, 200);
    assert.equal((await step(id, "inspect", { inspections: [okInspection(cod.itemIds[0])] })).status, 200);
    const refund = await step(id, "refund", { method: "upi", reference: "UPI-777777" });
    assert.equal(refund.status, 200, JSON.stringify(refund.json));
    assert.deepEqual(Object.values(await payStatus(cod.id)), ["Delivered", "Partially Refunded"]);
    // the rest of the same COD order can still be returned and refunded by hand
    const rest = await requestReturn(ids.c1, cod.id, [{ orderItemId: cod.itemIds[1], quantity: 1 }]);
    assert.equal(rest.status, 201, JSON.stringify(rest.json));
    const rid = rest.json.return.id;
    assert.equal((await step(rid, "approve")).status, 200);
    assert.equal((await step(rid, "received")).status, 200);
    assert.equal((await step(rid, "inspect", { inspections: [okInspection(cod.itemIds[1])] })).status, 200);
    assert.equal((await step(rid, "refund", { method: "cash", reference: "CASH-0002" })).status, 200);
    assert.deepEqual(Object.values(await payStatus(cod.id)), ["Returned", "Refunded"], "every rupee collected was paid back (free shipping), so it is fully Refunded");
  });

  await check("A5. financial report, dashboard and analytics count partial refunds by their real amounts", async () => {
    const owner = ids.owner;
    const istToday = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
    const istFrom = new Date(Date.now() + 330 * 60 * 1000 - 30 * 86400000).toISOString().slice(0, 10);
    const rep = await api("GET", `/api/superadmin/reports/financial?from=${istFrom}&to=${istToday}`, { as: owner });
    assert.equal(rep.status, 200, JSON.stringify(rep.json));
    const t = rep.json.data.totals;

    const sqlNum = async (sql) => Number((await one(sql)).v || 0);
    const completed =
      (await sqlNum("SELECT SUM(refund_amount) v FROM order_cancellations WHERE refund_status='completed'")) +
      (await sqlNum("SELECT SUM(refund_amount) v FROM return_requests WHERE refund_status='completed'"));
    // orders refunded the original way (no item-level record): the whole total
    const legacy = await sqlNum(
      `SELECT SUM(total_amount) v FROM orders o WHERE LOWER(payment_status)='refunded'
         AND NOT EXISTS (SELECT 1 FROM order_cancellations c WHERE c.order_id COLLATE utf8mb4_unicode_ci=o.id AND c.refund_status='completed')
         AND NOT EXISTS (SELECT 1 FROM return_requests r WHERE r.order_id COLLATE utf8mb4_unicode_ci=o.id AND r.refund_status='completed')`
    );
    assert.equal(t.refunds.refunded, Math.round((completed + legacy) * 100) / 100, "refunded = confirmed item-level refunds + whole-order refunds");
    const collected = await sqlNum("SELECT SUM(total_amount) v FROM orders WHERE LOWER(payment_status) IN ('paid','partially refunded','refund pending','refunded')");
    assert.equal(t.payments.collected, Math.round(collected * 100) / 100);
    assert.equal(t.net.received, Math.round((collected - completed - legacy) * 100) / 100, "net = collected - confirmed refunds");
    assert.ok(t.refunds.partiallyRefundedOrders >= 1, "partly refunded orders are counted");
    assert.ok(rep.json.data.notes.every((n) => !/whole order total/.test(n)));

    // revenue: partly refunded orders still count, for what remains
    const partial = await sqlNum(
      `SELECT SUM(o.total_amount - COALESCE((SELECT SUM(c.refund_amount) FROM order_cancellations c WHERE c.order_id COLLATE utf8mb4_unicode_ci=o.id AND c.refund_status='completed'),0)
                                  - COALESCE((SELECT SUM(r.refund_amount) FROM return_requests r WHERE r.order_id COLLATE utf8mb4_unicode_ci=o.id AND r.refund_status='completed'),0)) v
       FROM orders o WHERE LOWER(o.payment_status) IN ('paid','partially refunded') AND LOWER(o.status) NOT IN ('cancelled','cancellation requested','returned')`
    );
    // (the Super Admin dashboard has always counted Returned orders; analytics has not: unchanged)
    const partialDash = await sqlNum(
      `SELECT SUM(o.total_amount - COALESCE((SELECT SUM(c.refund_amount) FROM order_cancellations c WHERE c.order_id COLLATE utf8mb4_unicode_ci=o.id AND c.refund_status='completed'),0)
                                  - COALESCE((SELECT SUM(r.refund_amount) FROM return_requests r WHERE r.order_id COLLATE utf8mb4_unicode_ci=o.id AND r.refund_status='completed'),0)) v
       FROM orders o WHERE LOWER(o.payment_status) IN ('paid','partially refunded') AND LOWER(o.status) NOT IN ('cancelled','cancellation requested')`
    );
    const dash = await api("GET", "/api/superadmin/dashboard", { as: owner });
    assert.equal(dash.status, 200, JSON.stringify(dash.json));
    const dashRevenue = dash.json.data?.revenue?.last30Days;
    assert.equal(dashRevenue, Math.round(partialDash * 100) / 100, "dashboard revenue = net of partial refunds; got " + JSON.stringify(dash.json.data?.revenue));
    const an = await api("GET", `/api/admin/analytics?from=${istFrom}&to=${istToday}`, { as: ids.admin });
    assert.equal(an.status, 200, JSON.stringify(an.json));
    assert.equal(an.json.data.summary.revenue, Math.round(partial * 100) / 100);
    assert.equal(an.json.data.summary.refundedAmount, Math.round((completed + legacy) * 100) / 100);

    const csv = await fetch(`${base}/api/admin/exports/orders.csv?from=${istFrom}&to=${istToday}`, { headers: { Authorization: `Bearer ${tok(ids.admin)}` } });
    assert.equal(csv.status, 200);
    const lines = (await csv.text()).replace(/^﻿/, "").trim().split("\r\n");
    const header = lines[0].split(",");
    const sum = (name) => lines.slice(1).reduce((s, l) => s + Number(l.split(",")[header.indexOf(name)] || 0), 0);
    assert.equal(Math.round(sum("refunded_confirmed") * 100) / 100, Math.round((completed + legacy) * 100) / 100, "CSV refunded column matches");
  });

  // ---- return window = from the delivery date -----------------------------------------
  await check("B1. the window starts at the recorded delivery date, not at the order's last update", async () => {
    await reset();
    // updated just now (e.g. an admin touched it) but delivered 10 days ago -> window over
    const late = await returnDelivered({ lines: [{ variant: "v1", qty: 1, price: 800 }], deliveredMinutesAgo: 1 });
    await db.query(`INSERT INTO order_delivery_log (order_id, delivered_at) VALUES (?, DATE_SUB(${NOW}, INTERVAL 10 DAY))`, [late.id]);
    const r1 = await requestReturn(ids.c1, late.id, [{ orderItemId: late.itemIds[0], quantity: 1 }]);
    assert.equal(r1.json.code, "WINDOW_ENDED", JSON.stringify(r1.json));
    assert.equal((await api("GET", `/api/returns/order/${late.id}`, { as: ids.c1 })).json.eligible, false);

    // last updated 10 days ago (old edit) but delivered yesterday -> still open
    const fresh = await returnDelivered({ lines: [{ variant: "v1", qty: 1, price: 800 }], deliveredMinutesAgo: 60 * 24 * 10 });
    await db.query(`INSERT INTO order_delivery_log (order_id, delivered_at) VALUES (?, DATE_SUB(${NOW}, INTERVAL 1 DAY))`, [fresh.id]);
    const view = await api("GET", `/api/returns/order/${fresh.id}`, { as: ids.c1 });
    assert.equal(view.json.eligible, true);
    assert.ok(view.json.daysLeft >= 6 && view.json.daysLeft <= 7, "about 6 days left, got " + view.json.daysLeft);
    assert.equal((await requestReturn(ids.c1, fresh.id, [{ orderItemId: fresh.itemIds[0], quantity: 1 }])).status, 201);

    // orders delivered before the log existed fall back to their last update
    const legacy = await returnDelivered({ lines: [{ variant: "v1", qty: 1, price: 800 }], deliveredMinutesAgo: 60 * 24 * 10 });
    assert.equal((await requestReturn(ids.c1, legacy.id, [{ orderItemId: legacy.itemIds[0], quantity: 1 }])).json.code, "WINDOW_ENDED");
  });

  await check("B2. an admin marking an order Delivered records the delivery time; later edits do not restart the window", async () => {
    await reset();
    const o = await makeOrder({ status: "Shipped", method: "cod", payment: "Pending", lines: [{ variant: "v1", qty: 1, price: 800 }] });
    const r = await api("PATCH", `/api/orders/admin/${o.id}/status`, { as: ids.admin, body: { status: "Delivered" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const log = await one("SELECT delivered_at, recorded_by FROM order_delivery_log WHERE order_id=?", [o.id]);
    assert.ok(log && log.recorded_by === ids.admin, "the delivery time and who set it are recorded");
    assert.equal((await payStatus(o.id)).payment_status, "Paid", "COD becomes Paid on delivery (unchanged behaviour)");
    // Delivered again (a repeat click) must not move the start of the window
    await db.query(`UPDATE order_delivery_log SET delivered_at = DATE_SUB(${NOW}, INTERVAL 3 DAY) WHERE order_id=?`, [o.id]);
    await api("PATCH", `/api/orders/admin/${o.id}/status`, { as: ids.admin, body: { status: "Delivered" } });
    const again = await one("SELECT TIMESTAMPDIFF(HOUR, delivered_at, UTC_TIMESTAMP(6)) h FROM order_delivery_log WHERE order_id=?", [o.id]);
    assert.ok(Number(again.h) >= 71, "still about 3 days ago");
    assert.equal((await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }])).status, 201);
  });

  // ---- the original ("Cancellation Requested") flow versus the new one ----------------
  await check("C1. legacy 'Cancellation Requested' order: customer/admin dialogs are refused; the admin retry completes it ONCE (one refund, stock once)", async () => {
    await reset();
    const o = await makeOrder({ status: "Cancellation Requested", lines: [{ variant: "v1", qty: 2, price: 600 }] });
    await db.query("UPDATE product_variants SET inventory = inventory - 2 WHERE id = ?", [uuid(11)]);
    const before = await stock();
    assert.equal((await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind" })).status, 409);
    assert.equal((await adminCancel(o.id, { reasonCode: "out_of_stock" })).status, 409);
    assert.equal((await api("PATCH", `/api/orders/admin/${o.id}/status`, { as: ids.admin, body: { status: "Shipped" } })).status, 409, "cannot be moved on while the cancellation is pending");
    assert.equal(razorpayRefundsFor(o.paymentId).length, 0);

    const done = await Promise.all([1, 2].map(() => api("PATCH", `/api/orders/admin/${o.id}/retry-refund`, { as: ids.admin })));
    assert.equal(done.filter((r) => r.status === 200).length, 1, done.map((r) => r.status).join(","));
    assert.equal(razorpayRefundsFor(o.paymentId).length, 1, "exactly one refund");
    assert.equal(razorpayRefundsFor(o.paymentId)[0].amount, Math.round(o.total * 100));
    assert.deepEqual(Object.values(await payStatus(o.id)), ["Cancelled", "Refunded"]);
    const after = await stock();
    assert.equal(after.v1, before.v1 + 2, "stock back once");
    assert.equal((await api("PATCH", `/api/orders/admin/${o.id}/retry-refund`, { as: ids.admin })).status, 409);
    assert.equal(razorpayRefundsFor(o.paymentId).length, 1);
    assert.equal((await q("SELECT id FROM order_cancellations WHERE order_id=?", [o.id])).length, 0, "the original flow writes no item-level record");
  });

  await check("C2. the original whole-order refund refuses an order the new flow already touched (no double refund, no double stock)", async () => {
    await reset();
    const orderService = require(path.join(root, "services", "order.service.js"));
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 2, price: 600 }, { variant: "v2", qty: 1, price: 300 }] });
    const part = await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind", items: [{ orderItemId: o.itemIds[0], quantity: 1 }] });
    assert.equal(part.status, 200, JSON.stringify(part.json));
    const before = await stock();
    const calls = rz.calls.filter((c) => c.method === "POST").length;

    await assert.rejects(() => orderService.cancelOrderById(o.id, {}), (e) => e.code === "ITEM_LEVEL_ORDER" && e.statusCode === 409);
    await assert.rejects(() => orderService.cancelOrderById(o.id, { userId: ids.c1 }), (e) => e.code === "ITEM_LEVEL_ORDER");
    await assert.rejects(() => orderService.updateOrderStatus(o.id, "Cancelled", ids.admin), (e) => e.code === "ITEM_LEVEL_ORDER");
    assert.deepEqual(await stock(), before, "no second stock restore");
    assert.equal(rz.calls.filter((c) => c.method === "POST").length, calls, "no second refund");

    // a stuck 'Refund Pending' label on a fully cancelled order must not trigger a whole-total refund either
    const rest = await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind" });
    assert.equal(rest.status, 200);
    await db.query("UPDATE orders SET payment_status='Refund Pending' WHERE id=?", [o.id]);
    const callsBefore = rz.calls.filter((c) => c.method === "POST").length;
    const retry = await api("PATCH", `/api/orders/admin/${o.id}/retry-refund`, { as: ids.admin });
    assert.equal(retry.status, 409, JSON.stringify(retry.json));
    assert.equal(rz.calls.filter((c) => c.method === "POST").length, callsBefore);
    const report = await orderService.reconcilePendingRefunds({ apply: true, orderId: o.id });
    assert.deepEqual(report.map((r) => r.outcome), ["item_level_skipped"]);
    await db.query("UPDATE orders SET payment_status='Refunded' WHERE id=?", [o.id]);
  });

  // ---- status transitions ------------------------------------------------------------------
  await check("D1. admin status changes: no moving back out of Delivered, Returned is final, Returned only from Delivered and not during a return", async () => {
    await reset();
    const put = (id, status) => api("PATCH", `/api/orders/admin/${id}/status`, { as: ids.admin, body: { status } });
    const a = await makeOrder({ status: "Processing", lines: [{ variant: "v1", qty: 1, price: 800 }] });
    assert.equal((await put(a.id, "Returned")).json.code === undefined ? 409 : 409, 409);
    assert.equal((await put(a.id, "Returned")).status, 409, "not delivered yet");
    assert.equal((await put(a.id, "Shipped")).status, 200);
    assert.equal((await put(a.id, "Delivered")).status, 200);
    assert.equal((await put(a.id, "Processing")).status, 409, "cannot un-deliver");
    assert.equal((await put(a.id, "Shipped")).status, 409);

    const b = await returnDelivered({ lines: [{ variant: "v1", qty: 1, price: 800 }] });
    const made = await requestReturn(ids.c1, b.id, [{ orderItemId: b.itemIds[0], quantity: 1 }]);
    assert.equal(made.status, 201);
    const blocked = await put(b.id, "Returned");
    assert.equal(blocked.status, 409, "a return is in progress: finish it on the Returns page");
    assert.equal((await payStatus(b.id)).status, "Delivered");

    const c = await returnDelivered({ lines: [{ variant: "v1", qty: 1, price: 800 }] });
    assert.equal((await put(c.id, "Returned")).status, 200, "the original manual 'Returned' still works when no return exists");
    assert.equal((await put(c.id, "Delivered")).status, 409, "a returned order is final");
  });

  await check("D2. units cancelled before dispatch do not stop the order becoming Returned once everything else came back", async () => {
    await reset();
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 2, price: 600 }, { variant: "v2", qty: 1, price: 300 }] });
    assert.equal((await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind", items: [{ orderItemId: o.itemIds[0], quantity: 1 }] })).status, 200);
    await db.query("UPDATE orders SET status='Delivered', updated_at=UTC_TIMESTAMP(6) WHERE id=?", [o.id]);
    const ret = await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }, { orderItemId: o.itemIds[1], quantity: 1 }]);
    assert.equal(ret.status, 201, JSON.stringify(ret.json));
    assert.equal((await finishReturnFor(ret.json.return.id, o.itemIds)).status, 200);
    assert.equal((await payStatus(o.id)).status, "Returned");
    const refunds = razorpayRefundsFor(o.paymentId);
    assert.ok(refunds.reduce((s, r) => s + r.amount, 0) <= Math.round(o.total * 100), "never more than was paid");
  });

  // ======================================================================= REFUND STATUS CHECK, HISTORY, AUTO SYNC
  const refundSync = require(path.join(root, "services", "refund-sync.service.js"));
  const posts = () => rz.calls.filter((c) => c.method === "POST").length;
  const checkOrderRefunds = (orderId, as = ids.admin) => api("POST", `/api/orders/admin/${orderId}/refunds/check`, { as });
  const refundHistory = (orderId, as = ids.admin) => api("GET", `/api/orders/admin/${orderId}/refunds`, { as });
  const partialCancelPending = async () => {
    await reset();
    rz.mode = "pending";
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 2, price: 600 }, { variant: "v2", qty: 1, price: 300 }] });
    const r = await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind", items: [{ orderItemId: o.itemIds[0], quantity: 1 }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    rz.mode = "processed";
    const row = await one("SELECT id, refund_id, refund_status, refund_amount FROM order_cancellations WHERE order_id=?", [o.id]);
    assert.equal(row.refund_status, "processing");
    return { o, row };
  };

  await check("S1. partial cancellation: Razorpay says processed later, no webhook -> the admin check records it (Partially Refunded), no new refund, once", async () => {
    const { o, row } = await partialCancelPending();
    mails.length = 0;
    const before = posts();
    // still pending at Razorpay: the check changes nothing
    let r = await checkOrderRefunds(o.id);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.checked, 1);
    assert.equal((await one("SELECT refund_status FROM order_cancellations WHERE id=?", [row.id])).refund_status, "processing");
    assert.equal((await payStatus(o.id)).payment_status, "Paid");
    assert.match(r.json.message, /not finished/);
    // Razorpay finishes it (the webhook never arrives)
    rz.refunds.find((x) => x.id === row.refund_id).status = "processed";
    r = await checkOrderRefunds(o.id);
    assert.match(r.json.message, /confirmed by Razorpay/);
    const done = await one("SELECT refund_status, refund_completed_at FROM order_cancellations WHERE id=?", [row.id]);
    assert.equal(done.refund_status, "completed");
    assert.ok(done.refund_completed_at);
    assert.equal((await payStatus(o.id)).payment_status, "Partially Refunded");
    assert.equal(mailsTo("is complete").length, 1);
    // again and again: nothing changes, nothing is sent
    for (let i = 0; i < 3; i++) assert.equal((await checkOrderRefunds(o.id)).json.checked, 0);
    assert.equal(posts(), before, "a status check never creates a refund");
    assert.equal(razorpayRefundsFor(o.paymentId).length, 1);
    assert.equal(mailsTo("is complete").length, 1, "no duplicate e-mail");
    assert.ok((await q("SELECT id FROM audit_logs WHERE action='order.refund_check' AND resource_id=?", [o.id])).length >= 1, "audited");
  });

  await check("S2. return refund: same check works from the Returns page and from the order; concurrent checks do not change anything twice", async () => {
    await reset();
    rz.mode = "pending";
    const o = await returnDelivered({ lines: [{ variant: "v1", qty: 1, price: 900 }, { variant: "v2", qty: 1, price: 300 }] });
    const made = await requestReturn(ids.c1, o.id, [{ orderItemId: o.itemIds[0], quantity: 1 }]);
    const id = made.json.return.id;
    assert.equal((await step(id, "approve")).status, 200);
    assert.equal((await step(id, "received")).status, 200);
    assert.equal((await step(id, "inspect", { inspections: [okInspection(o.itemIds[0])] })).status, 200);
    assert.equal((await step(id, "refund")).status, 200);
    rz.mode = "processed";
    assert.equal((await one("SELECT refund_status FROM return_requests WHERE id=?", [id])).refund_status, "processing");
    const before = posts();
    rz.refunds.at(-1).status = "processed";
    const results = await Promise.all([
      api("POST", `/api/admin/returns/${id}/refund-check`, { as: ids.admin }),
      checkOrderRefunds(o.id),
      api("POST", `/api/admin/returns/${id}/refund-check`, { as: ids.admin }),
    ]);
    assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join(","));
    const r = await one("SELECT status, refund_status FROM return_requests WHERE id=?", [id]);
    assert.deepEqual([r.status, r.refund_status], ["Completed", "completed"], "the return finishes once the refund is confirmed");
    assert.equal((await payStatus(o.id)).payment_status, "Partially Refunded");
    assert.equal(posts(), before);
    assert.equal(mailsTo("is complete").filter((m) => m.subject.includes("return refund")).length, 1, "one e-mail only");
    assert.equal((await q("SELECT dedupe_key, COUNT(*) n FROM notification_log GROUP BY dedupe_key HAVING n > 1")).length, 0);
  });

  await check("S3. a retry on a refund that already has a Razorpay id only LOOKS it up: even if Razorpay does not list it, no second refund is created", async () => {
    const { o, row } = await partialCancelPending();
    const before = posts();
    const hidden = rz.refunds.splice(rz.refunds.findIndex((x) => x.id === row.refund_id), 1)[0]; // Razorpay's list does not show it
    const retry = await api("PATCH", `/api/orders/admin/${o.id}/retry-refund`, { as: ids.admin });
    assert.ok([200, 409].includes(retry.status), JSON.stringify(retry.json));
    assert.equal(posts(), before, "no refund was created");
    assert.equal((await one("SELECT refund_status FROM order_cancellations WHERE id=?", [row.id])).refund_status, "processing");
    rz.refunds.push(hidden);
    hidden.status = "processed";
    await api("PATCH", `/api/orders/admin/${o.id}/retry-refund`, { as: ids.admin });
    assert.equal((await one("SELECT refund_status FROM order_cancellations WHERE id=?", [row.id])).refund_status, "completed");
    assert.equal(posts(), before);
  });

  await check("S4. Razorpay unreachable: the check says so and changes nothing; Razorpay reports failed: recorded as failed, a retry then makes exactly one new refund", async () => {
    const { o, row } = await partialCancelPending();
    rz.listFails = true;
    const down = await checkOrderRefunds(o.id);
    rz.listFails = false;
    assert.equal(down.status, 200);
    assert.match(down.json.message, /could not be reached/);
    assert.equal((await one("SELECT refund_status FROM order_cancellations WHERE id=?", [row.id])).refund_status, "processing");

    rz.refunds.find((x) => x.id === row.refund_id).status = "failed";
    const failed = await checkOrderRefunds(o.id);
    assert.match(failed.json.message, /failed/);
    assert.equal((await one("SELECT refund_status FROM order_cancellations WHERE id=?", [row.id])).refund_status, "failed");
    assert.equal((await payStatus(o.id)).payment_status, "Paid");
    const before = posts();
    const retry = await api("PATCH", `/api/orders/admin/${o.id}/retry-refund`, { as: ids.admin });
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(posts(), before + 1, "exactly one new refund for the failed one");
    assert.equal((await one("SELECT refund_status FROM order_cancellations WHERE id=?", [row.id])).refund_status, "completed");
    assert.equal((await payStatus(o.id)).payment_status, "Partially Refunded");
  });

  await check("S5. a refund that was never sent is NOT sent by the check (only Retry sends)", async () => {
    await reset();
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 1, price: 900 }] });
    rz.failNext = { status: 400, description: "Your account does not have enough balance to carry out the refund operation." };
    assert.equal((await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind" })).status, 200);
    const row = await one("SELECT id, refund_status FROM order_cancellations WHERE order_id=?", [o.id]);
    assert.equal(row.refund_status, "failed");
    await db.query("UPDATE order_cancellations SET refund_status='pending', refund_id=NULL WHERE id=?", [row.id]);
    const before = posts();
    const r = await checkOrderRefunds(o.id);
    assert.equal(r.json.checked, 0, "pending rows are not looked up or sent");
    assert.equal(posts(), before);
    const hist = await refundHistory(o.id);
    assert.equal(hist.json.entries[0].canRetry, true);
    assert.equal(hist.json.entries[0].canCheck, false);
  });

  await check("S6. automatic sync: processing refunds are looked up and completed; nothing is ever created; only admins can use the endpoints", async () => {
    const a = await partialCancelPending();
    const b = await partialCancelPending();
    const before = posts();
    const both = [a, b];
    for (const x of both) rz.refunds.find((r) => r.id === x.row.refund_id).status = "processed";
    await db.query("UPDATE order_cancellations SET updated_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 10 MINUTE) WHERE id IN (?, ?)", [a.row.id, b.row.id]);
    const summary = await refundSync.autoSyncOnce();
    assert.ok(summary.completed >= 2, JSON.stringify(summary));
    for (const x of both) {
      assert.equal((await one("SELECT refund_status FROM order_cancellations WHERE id=?", [x.row.id])).refund_status, "completed");
      assert.equal((await payStatus(x.o.id)).payment_status, "Partially Refunded");
    }
    assert.equal(posts(), before, "the sweep never creates a refund");
    const again = await refundSync.autoSyncOnce();
    assert.equal(again.completed, 0);
    // a recent attempt (under 2 minutes) is left alone
    const c = await partialCancelPending();
    rz.refunds.find((r) => r.id === c.row.refund_id).status = "processed";
    const fresh = await refundSync.autoSyncOnce();
    assert.equal((await one("SELECT refund_status FROM order_cancellations WHERE id=?", [c.row.id])).refund_status, "processing");
    assert.equal(fresh.examined, 0);

    assert.equal((await refundHistory(c.o.id, ids.c1)).status, 403, "customers cannot read the money history");
    assert.equal((await checkOrderRefunds(c.o.id, ids.c1)).status, 403);
    assert.equal((await api("GET", `/api/orders/admin/${c.o.id}/refunds`)).status, 401);
  });

  await check("S7. refund history: one row per cancellation / return refund with items, amount, status, Razorpay id, error and totals", async () => {
    await reset();
    const o = await makeOrder({ lines: [{ variant: "v1", qty: 2, price: 600 }, { variant: "v2", qty: 1, price: 300 }] });
    assert.equal((await cancelAs(ids.c1, o.id, { reasonCode: "changed_mind", items: [{ orderItemId: o.itemIds[0], quantity: 1 }] })).status, 200);
    assert.equal((await adminCancel(o.id, { reasonCode: "out_of_stock", items: [{ orderItemId: o.itemIds[1], quantity: 1 }] })).status, 200);
    const h = await refundHistory(o.id);
    assert.equal(h.status, 200, JSON.stringify(h.json));
    assert.equal(h.json.entries.length, 2);
    const [first, second] = h.json.entries;
    assert.equal(first.kind, "cancellation");
    assert.deepEqual(first.items, [{ name: "Tee", quantity: 1 }]);
    assert.equal(first.status, "completed");
    assert.equal(first.statusLabel, "Refunded");
    assert.ok(first.refundId && first.amount > 0 && first.completedAt);
    assert.equal(second.by, "admin");
    const total = h.json.entries.reduce((s, e) => s + e.amount, 0);
    assert.equal(h.json.totals.refundedConfirmed, Math.round(total * 100) / 100);
    assert.equal(h.json.totals.paid, o.total);
    assert.equal(Math.round((h.json.totals.refundedConfirmed + h.json.totals.stillHeld) * 100) / 100, o.total);
    assert.equal(h.json.order.paymentStatus, "Partially Refunded");
    assert.equal((await refundHistory("no-such-order")).status, 404);
    // an order with nothing to show
    const plain = await makeOrder({ lines: [{ variant: "v1", qty: 1, price: 500 }] });
    assert.deepEqual((await refundHistory(plain.id)).json.entries, []);
  });

  // ======================================================================= DATA INTEGRITY + ANALYTICS
  await check("data integrity: existing order and item rows are never rewritten by cancellations or returns", async () => {
    const orders = await q("SELECT id, total_amount, subtotal, shipping_amount, discount_amount, tax_amount FROM orders");
    const items = await q("SELECT id, quantity, unit_price FROM order_items");
    // totals still add up to what the pricing rules produced at creation time
    for (const o of orders) {
      const expected = roundMoney(Number(o.subtotal) - Number(o.discount_amount) + Number(o.shipping_amount) + Number(o.tax_amount));
      assert.equal(Number(o.total_amount), expected, o.id);
    }
    for (const i of items) assert.ok(Number(i.quantity) >= 1 && Number(i.unit_price) > 0);
    // nothing was refunded twice: per payment, refunds never exceed the amount captured
    for (const [paymentId, payment] of rz.payments) {
      const refunded = rz.refunds.filter((r) => r.payment_id === paymentId && r.status !== "failed").reduce((s, r) => s + r.amount, 0);
      assert.ok(refunded <= payment.amount, `${paymentId}: refunded ${refunded} of ${payment.amount}`);
    }
    // every refund we hold at Razorpay has a unique receipt, i.e. is one of ours exactly once
    const receipts = rz.refunds.filter((r) => r.status !== "failed").map((r) => r.receipt); // a failed refund may be retried under the same key
    assert.equal(new Set(receipts).size, receipts.length);
    // stock never negative
    const neg = await q("SELECT id FROM product_variants WHERE inventory < 0");
    assert.equal(neg.length, 0);
    // dedupe keys really prevent a second movement
    const dupes = await q("SELECT dedupe_key, COUNT(*) n FROM inventory_movements WHERE dedupe_key IS NOT NULL GROUP BY dedupe_key HAVING n > 1");
    assert.equal(dupes.length, 0);
  });

  await check("audit: cancellations and every return step are recorded with actor, action, record and reason; no write route exists", async () => {
    const actions = (await q("SELECT DISTINCT action FROM audit_logs")).map((r) => r.action);
    for (const wanted of ["order.cancel", "return.request", "return.approve", "return.reject", "return.shipped", "return.received", "return.inspect", "return.refund", "return.refund_retry"]) {
      assert.ok(actions.includes(wanted), `missing audit action ${wanted} (have ${actions.join(", ")})`);
    }
    const sample = await one("SELECT actor_id, actor_role, resource_type, resource_id, created_at FROM audit_logs WHERE action='return.inspect' LIMIT 1");
    assert.ok(sample.actor_id && sample.actor_role === "admin" && sample.resource_type === "return" && sample.resource_id && sample.created_at);
    assert.equal((await api("DELETE", "/api/superadmin/audit-logs/x", { as: ids.owner })).status, 404);
  });

  await check("18. customers were e-mailed once per event (no duplicates anywhere)", async () => {
    const dup = await q("SELECT dedupe_key, COUNT(*) n FROM notification_log GROUP BY dedupe_key HAVING n > 1");
    assert.equal(dup.length, 0);
    const keys = (await q("SELECT dedupe_key FROM notification_log")).map((r) => r.dedupe_key.split(":")[0]);
    for (const wanted of ["cancel-confirmed", "refund_completed", "return-submitted", "return-approved", "return-received", "return-inspected"]) {
      assert.ok(keys.includes(wanted), `no '${wanted}' e-mail was recorded`);
    }
    assert.equal((await q("SELECT dedupe_key FROM notification_log WHERE status='failed'")).length, 0);
  });

  await check("analytics: counts come from the real records and partial returns are not double counted", async () => {
    const res = await api("GET", "/api/admin/reports/returns", { as: ids.admin });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const d = res.json.data;
    assert.equal(d.available, true);
    const cancels = (await one("SELECT COUNT(*) n, COALESCE(SUM(whole_order),0) w FROM order_cancellations")).n;
    assert.equal(d.cancellations.requests, Number(cancels));
    const returnsTotal = (await one("SELECT COUNT(*) n FROM return_requests")).n;
    assert.equal(d.returns.requests, Number(returnsTotal), "one per request, not per item");
    assert.equal(d.returns.requests, d.returns.pending + d.returns.approved + d.returns.rejected, "every request is in exactly one bucket");
    const units = (await one("SELECT COALESCE(SUM(i.quantity),0) n FROM return_request_items i JOIN return_requests r ON r.id=i.return_id WHERE r.status <> 'Rejected'")).n;
    assert.equal(d.returns.unitsReturned, Number(units));
    const doneAmount = Number((await one("SELECT COALESCE(SUM(refund_amount),0) a FROM order_cancellations WHERE refund_status='completed'")).a) +
      Number((await one("SELECT COALESCE(SUM(refund_amount),0) a FROM return_requests WHERE refund_status='completed'")).a);
    assert.equal(d.refunds.refundedAmount, Math.round(doneAmount * 100) / 100);
    assert.ok(d.reasons.cancellation.some((r) => r.code === "changed_mind"));
    assert.ok(d.reasons.returns.length > 0);
    assert.ok(d.products.length > 0 && d.products.every((p) => p.unitsReturned > 0 && p.name));
    assert.equal((await api("GET", "/api/admin/reports/returns?from=nope", { as: ids.admin })).status, 400);
    assert.equal((await api("GET", "/api/admin/reports/returns", { as: ids.c1 })).status, 403);
  });

  await check("existing orders and payment records are intact (the tables the migration did not own)", async () => {
    const shape = await q("SELECT column_name n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='orders' ORDER BY ordinal_position");
    assert.ok(!shape.some((c) => /cancel|return|refund/i.test(c.n)), "no column was added to orders");
    const itemShape = await q("SELECT column_name n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='order_items'");
    assert.ok(!itemShape.some((c) => /cancel|return|refund/i.test(c.n)), "no column was added to order_items");
  });

  server.close();
  await db.end();
  const failed = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed | Razorpay calls simulated: ${rz.calls.length} | refunds created at the simulated Razorpay: ${rz.refunds.length} | e-mails captured: ${mails.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(2);
});
