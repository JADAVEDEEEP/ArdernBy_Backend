const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");

process.env.RAZORPAY_KEY_ID = "rzp_test_unit";
process.env.RAZORPAY_KEY_SECRET = "unit_secret";

const root = path.join(__dirname, "..");
const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

// Minimal in-memory `orders` table answering exactly what payment.service asks.
const orders = [];
const pool = {
  async execute(sql, p = []) {
    const t = norm(sql);

    if (t.startsWith("select") && t.includes("from orders where id = ? and user_id = ?")) {
      const rows = orders.filter((o) => o.id === p[0] && o.user_id === p[1]);
      // staleRead simulates a parallel request that has already paid the order
      // while this request still holds the Pending snapshot it read earlier.
      return [
        staleRead
          ? rows.map((o) => ({ ...o, status: "Processing", payment_status: "Pending", payment_id: null }))
          : rows,
      ];
    }

    if (t.startsWith("update orders set payment_order_id = ?")) {
      const o = orders.find(
        (x) =>
          x.id === p[1] &&
          x.user_id === p[2] &&
          x.status === "Processing" &&
          x.payment_status.toLowerCase() !== "paid"
      );
      if (o) {
        o.payment_order_id = p[0];
        o.payment_status = "Pending";
      }
      return [{ affectedRows: o ? 1 : 0 }];
    }

    if (t.startsWith("select id, user_id, status, payment_status, payment_id from orders where id = ?")) {
      return [orders.filter((o) => o.id === p[0])];
    }

    if (t.startsWith("select variant_id, quantity from order_items")) {
      return [orderItems.filter((i) => i.order_id === p[0])];
    }

    if (t.startsWith("update product_variants set inventory = inventory - ?")) {
      const v = variants.find((x) => x.id === p[1]);
      if (v && v.inventory >= p[2]) {
        v.inventory -= p[0];
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }

    if (t.startsWith("update orders set payment_status = 'paid'")) {
      const o = orders.find((x) => x.id === p[1]);
      o.payment_status = "Paid";
      o.payment_id = p[0];
      o.status = "Confirmed";
      return [{ affectedRows: 1 }];
    }

    if (t.startsWith("delete from cart_items where cart_id in")) {
      cartItems.length = 0;
      return [{ affectedRows: 1 }];
    }

    if (t.startsWith("update carts set coupon_code = null")) {
      cart.coupon_code = null;
      return [{ affectedRows: 1 }];
    }

    if (t.startsWith("update orders set status = 'cancelled', payment_status = 'refund pending'")) {
      const o = orders.find(
        (x) =>
          x.id === p[1] &&
          !["paid", "refunded", "refund pending"].includes(x.payment_status.toLowerCase())
      );
      if (o) {
        o.status = "Cancelled";
        o.payment_status = "Refund Pending";
        o.payment_id = p[0];
      }
      return [{ affectedRows: o ? 1 : 0 }];
    }

    if (t.startsWith("update orders set status = 'cancelled', payment_status = 'refunded'")) {
      // Mirrors the SQL guard: a Paid order is never rewritten.
      const o = orders.find((x) => x.id === p[1] && x.payment_status.toLowerCase() !== "paid");
      if (o) {
        o.status = "Cancelled";
        o.payment_status = "Refunded";
        o.payment_id = p[0];
      }
      return [{ affectedRows: o ? 1 : 0 }];
    }

    if (t.startsWith("update orders set payment_status = 'failed'")) {
      const o = orders.find(
        (x) =>
          x.id === p[0] &&
          x.user_id === p[1] &&
          x.payment_method === "online" &&
          x.payment_status.toLowerCase() === "pending"
      );
      if (o) o.payment_status = "Failed";
      return [{ affectedRows: o ? 1 : 0 }];
    }

    if (
      t.startsWith(
        "select id, order_number, status, payment_method, payment_status, total_amount, payment_order_id, payment_id from orders where payment_order_id = ?"
      )
    ) {
      return [orders.filter((o) => o.payment_order_id === p[0])];
    }

    throw new Error(`unhandled SQL: ${t}`);
  },
  async getConnection() {
    return {
      execute: (sql, p) => pool.execute(sql, p),
      beginTransaction: async () => takeSnapshot(),
      commit: async () => {},
      // Mirrors a real rollback: nothing the transaction wrote may survive.
      rollback: async () => {
        restore();
      },
      release: () => {},
    };
  },
};

let staleRead = false;
const variants = [];
const orderItems = [];
const cartItems = [];
const cart = { coupon_code: null };
let snapshot = null;

const takeSnapshot = () => {
  snapshot = JSON.stringify({ variants, orders });
};
const restore = () => {
  if (!snapshot) return;
  const saved = JSON.parse(snapshot);
  variants.splice(0, variants.length, ...saved.variants);
  orders.splice(0, orders.length, ...saved.orders);
};

const sqlPath = require.resolve(path.join(root, "config", "sql"));
require.cache[sqlPath] = {
  id: sqlPath,
  filename: sqlPath,
  loaded: true,
  exports: { poolPromise: Promise.resolve(pool) },
};

const paymentService = require("../services/payment.service");
const razorpay = require("../services/razorpay.service");

const sign = (orderId, paymentId, secret = "unit_secret") =>
  crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

let apiCalls;
const realFetch = global.fetch;

test.beforeEach(() => {
  staleRead = false;
  orders.length = 0;
  orders.push({
    id: "o1",
    user_id: "u1",
    order_number: "ARD-1",
    status: "Processing",
    payment_method: "online",
    payment_status: "Pending",
    total_amount: 1234.5,
    payment_order_id: null,
    payment_id: null,
  });
  variants.length = 0;
  variants.push({ id: "v1", inventory: 5 });
  orderItems.length = 0;
  orderItems.push({ order_id: "o1", variant_id: "v1", quantity: 2 });
  cartItems.length = 0;
  cartItems.push({ id: "ci1" });
  cart.coupon_code = "SAVE10";
  apiCalls = [];
  global.fetch = async (url, init) => {
    apiCalls.push({ url, init });
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.endsWith("/orders") && init.method === "POST") {
      return { ok: true, json: async () => ({ id: "order_RZP1", amount: body.amount, currency: "INR" }) };
    }
    if (url.includes("/refund")) {
      return { ok: true, json: async () => ({ id: "rfnd_1" }) };
    }
    if (url.includes("/payments") && init.method === "GET") {
      return {
        ok: true,
        json: async () => ({ items: [{ id: "pay_SYNC", status: "captured", amount: 123450 }] }),
      };
    }
    throw new Error(`unexpected ${url}`);
  };
});

test.after(() => {
  global.fetch = realFetch;
});

// ===========================================================================
// Order confirmation e-mail triggers inside the payment flow (verify, sync and
// the Razorpay webhook). The e-mail sender itself is stubbed here: its own
// behaviour (send once, never throw) is covered in order-email.test.js.
// ===========================================================================

const orderEmail = require("../services/order-email.service");
const realSend = orderEmail.sendOrderConfirmation;
let confirmations = [];
let sendBehaviour = "ok";

test.beforeEach(() => {
  confirmations = [];
  sendBehaviour = "ok";
  orderEmail.sendOrderConfirmation = (orderId) => {
    confirmations.push(orderId);
    if (sendBehaviour === "throw") throw new Error("mail exploded");
    if (sendBehaviour === "reject") return Promise.reject(new Error("mail rejected"));
    return Promise.resolve({ sent: true });
  };
});

test.after(() => {
  orderEmail.sendOrderConfirmation = realSend;
});

const payArgs = (paymentId = "pay_1") => ({
  userId: "u1",
  orderId: "o1",
  razorpayOrderId: "order_RZP1",
  razorpayPaymentId: paymentId,
  signature: sign("order_RZP1", paymentId),
});

test("e-mail: a verified payment asks for exactly one confirmation", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  const result = await paymentService.verifyPayment(payArgs());
  assert.equal(result.paid, true);
  assert.deepEqual(confirmations, ["o1"]);
});

test("e-mail: the Razorpay webhook confirms a customer who never came back", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  const result = await paymentService.settleWebhookPayment({
    razorpayOrderId: "order_RZP1",
    paymentId: "pay_WH",
    amountPaise: 123450,
  });
  assert.deepEqual(result, { handled: true, outcome: "paid" });
  assert.deepEqual(confirmations, ["o1"]);
});

test("e-mail: a repeated webhook delivery after payment does not trigger another e-mail", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  const args = { razorpayOrderId: "order_RZP1", paymentId: "pay_WH", amountPaise: 123450 };
  await paymentService.settleWebhookPayment(args);
  const again = await paymentService.settleWebhookPayment(args);
  assert.deepEqual(again, { handled: true, outcome: "already_paid" });
  assert.equal(confirmations.length, 1);
});

test("e-mail: sync confirms only when Razorpay shows a matching captured payment", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  const result = await paymentService.syncPayment({ userId: "u1", orderId: "o1" });
  assert.equal(result.paid, true);
  assert.deepEqual(confirmations, ["o1"]);
});

test("e-mail: forged or mismatched payments never ask for a confirmation", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });

  await assert.rejects(
    paymentService.verifyPayment({ ...payArgs(), signature: sign("order_RZP1", "pay_1", "wrong_secret") }),
    /verification failed/
  );
  await assert.rejects(
    paymentService.verifyPayment({ ...payArgs(), razorpayOrderId: "order_OTHER", signature: sign("order_OTHER", "pay_1") }),
    /does not match/
  );
  const wrongAmount = await paymentService.settleWebhookPayment({
    razorpayOrderId: "order_RZP1",
    paymentId: "pay_WH",
    amountPaise: 100,
  });
  assert.deepEqual(wrongAmount, { handled: false, reason: "amount_mismatch" });
  const unknown = await paymentService.settleWebhookPayment({ razorpayOrderId: "order_NOPE", paymentId: "pay_X", amountPaise: 1 });
  assert.equal(unknown.handled, false);

  assert.deepEqual(confirmations, []);
  assert.notEqual(orders[0].payment_status, "Paid");
});

test("e-mail: a payment that failed or an item that sold out never asks for a confirmation", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  await paymentService.markFailed({ userId: "u1", orderId: "o1" });
  assert.deepEqual(confirmations, []);

  // Sold out while paying: the money is refunded instead, so no "confirmed" mail.
  orders[0].payment_status = "Pending";
  orders[0].status = "Processing";
  variants[0].inventory = 0;
  await assert.rejects(paymentService.verifyPayment(payArgs()));
  assert.deepEqual(confirmations, []);
});

test("e-mail: an order already cancelled/expired before payment arrived gets no confirmation", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  orders[0].status = "Cancelled";
  await assert.rejects(paymentService.verifyPayment(payArgs()));
  assert.deepEqual(confirmations, []);
});

test("e-mail: a failing or throwing e-mail never breaks payment", async () => {
  for (const behaviour of ["throw", "reject"]) {
    sendBehaviour = behaviour;
    confirmations = [];
    orders[0].status = "Processing";
    orders[0].payment_status = "Pending";
    orders[0].payment_id = null;
    variants[0].inventory = 5;
    await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
    const result = await paymentService.verifyPayment(payArgs());
    assert.equal(result.paid, true, behaviour);
    assert.equal(orders[0].payment_status, "Paid", behaviour);
    assert.equal(orders[0].status, "Confirmed", behaviour);
    assert.equal(variants[0].inventory, 3, behaviour);
  }
});
