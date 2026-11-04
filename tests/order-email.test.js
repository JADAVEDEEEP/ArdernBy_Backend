const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Order confirmation e-mail: when it is sent, that it is sent once, and that an
// e-mail problem can never throw. Runs the REAL notification + order-email code
// against an in-memory stand-in for MySQL and a stubbed mailer (nothing is sent).

const root = path.join(__dirname, "..");
const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

const orders = [];
const orderItems = [];
const profiles = [];
const log = new Map(); // notification_log by dedupe_key
let logTableMissing = false;
let dbDown = false;

const pool = {
  async execute(sql, p = []) {
    const t = norm(sql);
    if (dbDown) throw new Error("db down");

    if (t.startsWith("select id, user_id, order_number, status, payment_method")) {
      return [orders.filter((o) => o.id === p[0])];
    }
    if (t.startsWith("select product_name, size, color, quantity, unit_price from order_items")) {
      return [orderItems.filter((i) => i.order_id === p[0])];
    }
    if (t.startsWith("select email, full_name from profiles")) {
      return [profiles.filter((x) => x.id === p[0])];
    }
    if (t.startsWith("insert ignore into notification_log")) {
      if (logTableMissing) {
        const error = new Error("no such table");
        error.code = "ER_NO_SUCH_TABLE";
        throw error;
      }
      if (log.has(p[0])) return [{ affectedRows: 0 }];
      log.set(p[0], { recipient: p[1], template: p[2], status: "sending" });
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("update notification_log set status = 'sending'")) {
      const row = log.get(p[0]);
      if (row && row.status === "failed") {
        row.status = "sending";
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }
    if (t.startsWith("update notification_log set status = 'sent'")) {
      log.get(p[0]).status = "sent";
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("update notification_log set status = 'failed'")) {
      log.get(p[1]).status = "failed";
      return [{ affectedRows: 1 }];
    }
    throw new Error(`unhandled SQL: ${t}`);
  },
};

const sqlPath = require.resolve(path.join(root, "config", "sql.js"));
require.cache[sqlPath] = {
  id: sqlPath,
  filename: sqlPath,
  loaded: true,
  exports: { poolPromise: Promise.resolve(pool) },
};

process.env.BREVO_FROM_EMAIL = "shop@example.test";
const mailer = require(path.join(root, "config", "mailer.js"));
const mails = [];
let mailFails = false;
mailer.transporter.sendMail = async (message) => {
  if (mailFails) throw new Error("smtp down");
  mails.push(message);
  return {};
};

const orderEmail = require(path.join(root, "services", "order-email.service.js"));

const baseOrder = (over = {}) => ({
  id: "o1",
  user_id: "u1",
  order_number: "ARD-1001",
  status: "Confirmed",
  payment_method: "cod",
  payment_status: "Pending",
  subtotal: "1290.00",
  shipping_amount: "0.00",
  discount_amount: "90.00",
  tax_amount: "65.00",
  total_amount: "1265.00",
  coupon_code: "WELCOME15",
  created_at: new Date("2026-11-04T10:00:00Z"),
  shipping_name: "Asha Rao",
  shipping_phone: "9876543210",
  shipping_address: "12 Park Street",
  shipping_city: "Pune",
  shipping_state: "Maharashtra",
  shipping_pincode: "411001",
  ...over,
});

test.beforeEach(() => {
  orders.length = 0;
  orderItems.length = 0;
  profiles.length = 0;
  log.clear();
  mails.length = 0;
  mailFails = false;
  logTableMissing = false;
  dbDown = false;
  profiles.push({ id: "u1", email: "asha@example.test", full_name: "Asha Rao" });
  orderItems.push({ order_id: "o1", product_name: "Urban Oversized Black Tee", size: "XL", color: "Black", quantity: 2, unit_price: "645.00" });
});

test("COD order: one confirmation e-mail with the order details", async () => {
  orders.push(baseOrder());
  const result = await orderEmail.sendOrderConfirmation("o1");

  assert.equal(result.sent, true);
  assert.equal(mails.length, 1);
  const mail = mails[0];
  assert.equal(mail.to, "asha@example.test");
  assert.equal(mail.subject, "Your KOVENIK order ARD-1001 is confirmed");
  assert.match(mail.text, /Hello Asha,/);
  assert.match(mail.text, /Order number: ARD-1001/);
  assert.match(mail.text, /Urban Oversized Black Tee \(Size XL, Black\) x 2 {2}₹1,290\.00/);
  assert.match(mail.text, /Subtotal: ₹1,290\.00/);
  assert.match(mail.text, /Discount \(WELCOME15\): -₹90\.00/);
  assert.match(mail.text, /Shipping: Free/);
  assert.match(mail.text, /GST: ₹65\.00/);
  assert.match(mail.text, /Total: ₹1,265\.00/);
  assert.match(mail.text, /cash on delivery\. Please keep ₹1,265\.00 ready/);
  assert.match(mail.text, /12 Park Street/);
  assert.match(mail.text, /Pune, Maharashtra/);
  assert.match(mail.text, /My Orders/);
  assert.equal(log.get("order-confirmation:o1").status, "sent");
});

test("online order that is paid: confirmation says paid online", async () => {
  orders.push(baseOrder({ payment_method: "online", payment_status: "Paid" }));
  await orderEmail.sendOrderConfirmation("o1");
  assert.equal(mails.length, 1);
  assert.match(mails[0].text, /Payment: paid online/);
  assert.doesNotMatch(mails[0].text, /cash on delivery/);
});

test("duplicate events (verify + sync + webhook, repeated) send exactly one e-mail", async () => {
  orders.push(baseOrder({ payment_method: "online", payment_status: "Paid" }));
  await Promise.all([
    orderEmail.sendOrderConfirmation("o1"),
    orderEmail.sendOrderConfirmation("o1"),
    orderEmail.sendOrderConfirmation("o1"),
  ]);
  await orderEmail.sendOrderConfirmation("o1");
  assert.equal(mails.length, 1);
});

test("unpaid, pending, failed or cancelled orders never get a confirmation", async () => {
  const cases = [
    { payment_method: "online", status: "Processing", payment_status: "Pending" },
    { payment_method: "online", status: "Processing", payment_status: "Failed" },
    { payment_method: "online", status: "Cancelled", payment_status: "Failed" },
    { payment_method: "online", status: "Cancelled", payment_status: "Refunded" },
    { payment_method: "online", status: "Confirmed", payment_status: "Pending" }, // status says Confirmed but nothing was paid
    { payment_method: "online", status: "Cancelled", payment_status: "Refund Pending" },
    { payment_method: "cod", status: "Cancelled", payment_status: "Pending" },
    { payment_method: "cod", status: "Processing", payment_status: "Pending" },
    { payment_method: "wallet", status: "Confirmed", payment_status: "Paid" },
  ];
  for (const [index, over] of cases.entries()) {
    orders.length = 0;
    orders.push(baseOrder({ id: `x${index}`, ...over }));
    const result = await orderEmail.sendOrderConfirmation(`x${index}`);
    assert.equal(result.sent, false, JSON.stringify(over));
    assert.equal(result.skipped, "not_confirmed", JSON.stringify(over));
  }
  assert.equal(mails.length, 0);
  assert.equal(log.size, 0);
});

test("unknown order id or missing id sends nothing and does not throw", async () => {
  assert.deepEqual(await orderEmail.sendOrderConfirmation("nope"), { sent: false, skipped: "not_confirmed" });
  assert.deepEqual(await orderEmail.sendOrderConfirmation(undefined), { sent: false, skipped: "no_order" });
  assert.equal(mails.length, 0);
});

test("a mail failure never throws, is recorded, and a later attempt can still send", async () => {
  orders.push(baseOrder());
  mailFails = true;
  const failed = await orderEmail.sendOrderConfirmation("o1");
  assert.equal(failed.failed, true);
  assert.equal(mails.length, 0);
  assert.equal(log.get("order-confirmation:o1").status, "failed");

  mailFails = false;
  const retry = await orderEmail.sendOrderConfirmation("o1");
  assert.equal(retry.sent, true);
  assert.equal(mails.length, 1);
});

test("database or log-table problems never throw", async () => {
  orders.push(baseOrder());

  logTableMissing = true;
  const noTable = await orderEmail.sendOrderConfirmation("o1");
  assert.equal(noTable.sent, false);
  assert.equal(mails.length, 0);

  logTableMissing = false;
  dbDown = true;
  const down = await orderEmail.sendOrderConfirmation("o1");
  assert.equal(down.sent, false);
  assert.equal(down.failed, true);
  assert.equal(mails.length, 0);
});

test("a deleted account (placeholder address) gets no e-mail", async () => {
  orders.push(baseOrder());
  profiles[0].email = "gone123@deleted.ardenby.local";
  const result = await orderEmail.sendOrderConfirmation("o1");
  assert.equal(result.sent, false);
  assert.equal(mails.length, 0);
});

// ---- the order controller (cash on delivery trigger) ----

test("controller: COD order triggers the e-mail, online order does not, and e-mail trouble never changes the response", async () => {
  const orderServicePath = require.resolve(path.join(root, "services", "order.service.js"));
  const sent = [];
  let createOutcome = { id: "o9", orderNumber: "ARD-9" };
  require.cache[orderServicePath] = {
    id: orderServicePath,
    filename: orderServicePath,
    loaded: true,
    exports: {
      createOrder: async () => {
        if (createOutcome instanceof Error) throw createOutcome;
        return createOutcome;
      },
    },
  };
  const original = orderEmail.sendOrderConfirmation;
  const razorpay = require(path.join(root, "services", "razorpay.service.js"));
  const originalConfigured = razorpay.isConfigured;
  razorpay.isConfigured = () => true;

  const controllerPath = require.resolve(path.join(root, "controller", "order.controller.js"));
  delete require.cache[controllerPath];
  const controller = require(controllerPath);

  const call = async (paymentMethod) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await controller.createOrder(
      {
        user: { id: "u1" },
        body: {
          paymentMethod,
          shippingAddress: { name: "Asha Rao", phone: "9876543210", pincode: "411001", address: "12 Park Street", city: "Pune", state: "Maharashtra" },
        },
      },
      res
    );
    return res;
  };

  try {
    orderEmail.sendOrderConfirmation = (id) => { sent.push(id); return Promise.resolve({ sent: true }); };

    const cod = await call("cod");
    assert.equal(cod.statusCode, 201, JSON.stringify(cod.body));
    assert.deepEqual(sent, ["o9"]);

    const online = await call("online");
    assert.equal(online.statusCode, 201, JSON.stringify(online.body));
    assert.deepEqual(sent, ["o9"], "online orders are not confirmed at placement");

    createOutcome = new Error("Cart is empty.");
    const failedOrder = await call("cod");
    assert.equal(failedOrder.statusCode, 400);
    assert.deepEqual(sent, ["o9"], "a failed order never sends");

    createOutcome = { id: "o10", orderNumber: "ARD-10" };
    orderEmail.sendOrderConfirmation = () => { throw new Error("boom"); };
    const throwing = await call("cod");
    assert.equal(throwing.statusCode, 201, "a throwing e-mail must not change the response");

    orderEmail.sendOrderConfirmation = () => Promise.reject(new Error("boom async"));
    const rejecting = await call("cod");
    assert.equal(rejecting.statusCode, 201);
  } finally {
    orderEmail.sendOrderConfirmation = original;
    razorpay.isConfigured = originalConfigured;
    delete require.cache[controllerPath];
    delete require.cache[orderServicePath];
  }
});
