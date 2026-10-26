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

test("live keys are refused", () => {
  const saved = process.env.RAZORPAY_KEY_ID;
  process.env.RAZORPAY_KEY_ID = "rzp_live_abc";
  assert.equal(razorpay.isConfigured(), false);
  process.env.RAZORPAY_KEY_ID = saved;
});

test("signature check accepts the real HMAC and rejects tampering", () => {
  const good = sign("order_A", "pay_A");
  assert.equal(
    razorpay.verifySignature({ razorpayOrderId: "order_A", razorpayPaymentId: "pay_A", signature: good }),
    true
  );
  assert.equal(
    razorpay.verifySignature({ razorpayOrderId: "order_A", razorpayPaymentId: "pay_B", signature: good }),
    false
  );
  assert.equal(
    razorpay.verifySignature({ razorpayOrderId: "order_A", razorpayPaymentId: "pay_A", signature: "bad" }),
    false
  );
});

test("payment order amount comes from the saved order total, in paise", async () => {
  const payment = await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  assert.equal(payment.amount, 123450);
  assert.equal(payment.razorpayOrderId, "order_RZP1");
  assert.equal(JSON.parse(apiCalls[0].init.body).amount, 123450);
  assert.equal(orders[0].payment_order_id, "order_RZP1");
  // The secret is never returned to the browser.
  assert.equal(JSON.stringify(payment).includes("unit_secret"), false);
});

test("another user cannot pay for someone else's order", async () => {
  await assert.rejects(
    paymentService.createPaymentOrder({ userId: "intruder", orderId: "o1" }),
    /Order not found/
  );
});

test("valid signature marks the order Paid + Confirmed", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  const result = await paymentService.verifyPayment({
    userId: "u1",
    orderId: "o1",
    razorpayOrderId: "order_RZP1",
    razorpayPaymentId: "pay_1",
    signature: sign("order_RZP1", "pay_1"),
  });
  assert.equal(result.paid, true);
  assert.equal(orders[0].payment_status, "Paid");
  assert.equal(orders[0].status, "Confirmed");
  assert.equal(orders[0].payment_id, "pay_1");
});

test("forged signature never marks the order paid", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  await assert.rejects(
    paymentService.verifyPayment({
      userId: "u1",
      orderId: "o1",
      razorpayOrderId: "order_RZP1",
      razorpayPaymentId: "pay_1",
      signature: sign("order_RZP1", "pay_1", "wrong_secret"),
    }),
    /verification failed/
  );
  assert.notEqual(orders[0].payment_status, "Paid");
  assert.equal(orders[0].status, "Processing");
});

test("a signature for a different Razorpay order is rejected", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  await assert.rejects(
    paymentService.verifyPayment({
      userId: "u1",
      orderId: "o1",
      razorpayOrderId: "order_OTHER",
      razorpayPaymentId: "pay_1",
      signature: sign("order_OTHER", "pay_1"),
    }),
    /does not match/
  );
  assert.notEqual(orders[0].payment_status, "Paid");
});

test("verifying twice is idempotent; a different payment id is refused", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  const args = {
    userId: "u1",
    orderId: "o1",
    razorpayOrderId: "order_RZP1",
    razorpayPaymentId: "pay_1",
    signature: sign("order_RZP1", "pay_1"),
  };
  await paymentService.verifyPayment(args);
  const again = await paymentService.verifyPayment(args);
  assert.equal(again.paid, true);

  await assert.rejects(
    paymentService.verifyPayment({
      ...args,
      razorpayPaymentId: "pay_2",
      signature: sign("order_RZP1", "pay_2"),
    }),
    /already paid/
  );
  assert.equal(orders[0].payment_id, "pay_1");
});

test("failed payment can be retried and then paid", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  await paymentService.markFailed({ userId: "u1", orderId: "o1" });
  assert.equal(orders[0].payment_status, "Failed");

  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  assert.equal(orders[0].payment_status, "Pending");
});

test("a paid order can never be downgraded to Failed or re-opened", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  await paymentService.verifyPayment({
    userId: "u1",
    orderId: "o1",
    razorpayOrderId: "order_RZP1",
    razorpayPaymentId: "pay_1",
    signature: sign("order_RZP1", "pay_1"),
  });
  await paymentService.markFailed({ userId: "u1", orderId: "o1" });
  assert.equal(orders[0].payment_status, "Paid");
  await assert.rejects(
    paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" }),
    /already paid/
  );
});

test("payment verified after the order expired is auto-refunded, not confirmed", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  orders[0].status = "Cancelled"; // expired while the customer was paying
  await assert.rejects(
    paymentService.verifyPayment({
      userId: "u1",
      orderId: "o1",
      razorpayOrderId: "order_RZP1",
      razorpayPaymentId: "pay_1",
      signature: sign("order_RZP1", "pay_1"),
    }),
    /expired/
  );
  assert.equal(orders[0].payment_status, "Refunded");
  assert.ok(apiCalls.some((c) => c.url.includes("/payments/pay_1/refund")));
});

test("sync marks an order paid only when Razorpay shows a matching captured payment", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  const result = await paymentService.syncPayment({ userId: "u1", orderId: "o1" });
  assert.equal(result.paid, true);
  assert.equal(orders[0].payment_id, "pay_SYNC");
  assert.equal(orders[0].status, "Confirmed");
});

test("stock is taken and the cart cleared only when payment is verified", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  // Creating the payment must not touch stock or the cart.
  assert.equal(variants[0].inventory, 5);
  assert.equal(cartItems.length, 1);

  await paymentService.verifyPayment({
    userId: "u1",
    orderId: "o1",
    razorpayOrderId: "order_RZP1",
    razorpayPaymentId: "pay_1",
    signature: sign("order_RZP1", "pay_1"),
  });
  assert.equal(variants[0].inventory, 3);
  assert.equal(cartItems.length, 0);
  assert.equal(cart.coupon_code, null);
});

test("failed or forged payments leave stock and cart untouched", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  await paymentService.markFailed({ userId: "u1", orderId: "o1" });
  await assert.rejects(
    paymentService.verifyPayment({
      userId: "u1",
      orderId: "o1",
      razorpayOrderId: "order_RZP1",
      razorpayPaymentId: "pay_1",
      signature: "forged",
    })
  );
  assert.equal(variants[0].inventory, 5);
  assert.equal(cartItems.length, 1);
  assert.equal(cart.coupon_code, "SAVE10");
});

test("an item that sold out during payment is refunded, stock never goes negative, cart kept", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  variants[0].inventory = 1; // another customer bought it meanwhile (needs 2)

  await assert.rejects(
    paymentService.verifyPayment({
      userId: "u1",
      orderId: "o1",
      razorpayOrderId: "order_RZP1",
      razorpayPaymentId: "pay_1",
      signature: sign("order_RZP1", "pay_1"),
    }),
    /sold out/
  );
  assert.equal(variants[0].inventory, 1);
  assert.equal(orders[0].payment_status, "Refunded");
  assert.equal(orders[0].status, "Cancelled");
  assert.ok(apiCalls.some((c) => c.url.includes("/payments/pay_1/refund")));
  assert.equal(cartItems.length, 1);
});

test("COD orders are never treated as online payments", async () => {
  orders[0].payment_method = "cod";
  await assert.rejects(
    paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" }),
    /not an online payment/
  );
});

test("a parallel verify that already recorded this payment is success, never a refund", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  // The other request won the race: the order is already Paid by pay_1.
  Object.assign(orders[0], { status: "Confirmed", payment_status: "Paid", payment_id: "pay_1" });
  staleRead = true;

  const result = await paymentService.verifyPayment({
    userId: "u1",
    orderId: "o1",
    razorpayOrderId: "order_RZP1",
    razorpayPaymentId: "pay_1",
    signature: sign("order_RZP1", "pay_1"),
  });

  assert.equal(result.paid, true);
  assert.equal(orders[0].status, "Confirmed");
  assert.equal(orders[0].payment_status, "Paid");
  assert.equal(apiCalls.some((c) => c.url.includes("/refund")), false, "a valid payment must not be refunded");
});

test("a second, different payment is refunded without touching the paid order", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  Object.assign(orders[0], { status: "Confirmed", payment_status: "Paid", payment_id: "pay_1" });
  staleRead = true;

  await assert.rejects(
    paymentService.verifyPayment({
      userId: "u1",
      orderId: "o1",
      razorpayOrderId: "order_RZP1",
      razorpayPaymentId: "pay_2",
      signature: sign("order_RZP1", "pay_2"),
    })
  );

  assert.equal(apiCalls.filter((c) => c.url.includes("/refund")).length, 1);
  assert.ok(apiCalls.some((c) => c.url.includes("/payments/pay_2/refund")));
  assert.equal(orders[0].status, "Confirmed");
  assert.equal(orders[0].payment_status, "Paid");
  assert.equal(orders[0].payment_id, "pay_1");
});

test("an auto-refund that fails is kept as Refund Pending for the admin retry, and is never attempted twice", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });
  variants[0].inventory = 1; // sold out meanwhile
  const realFetchStub = global.fetch;
  global.fetch = async (url, init) => {
    if (url.includes("/refund")) {
      apiCalls.push({ url, init });
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: { description: "down" } }) };
    }
    return realFetchStub(url, init);
  };

  const args = {
    userId: "u1",
    orderId: "o1",
    razorpayOrderId: "order_RZP1",
    razorpayPaymentId: "pay_1",
    signature: sign("order_RZP1", "pay_1"),
  };

  await assert.rejects(paymentService.verifyPayment(args), /sold out/);
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refund Pending");
  assert.equal(orders[0].payment_id, "pay_1");
  assert.equal(apiCalls.filter((c) => c.url.includes("/refund")).length, 1);

  // Replaying verify must not hit Razorpay's refund API again.
  await assert.rejects(paymentService.verifyPayment(args));
  assert.equal(apiCalls.filter((c) => c.url.includes("/refund")).length, 1);
});


/* ---------------------------------------------------------------------------
 *  Razorpay webhook
 * ------------------------------------------------------------------------- */

const WEBHOOK_SECRET = "whsec_unit";
const signBody = (raw, secret = WEBHOOK_SECRET) =>
  crypto.createHmac("sha256", secret).update(raw).digest("hex");

test("webhook signature is checked over the raw body with the webhook secret", () => {
  const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
  const raw = Buffer.from(JSON.stringify({ event: "payment.captured" }));

  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  assert.equal(razorpay.isWebhookConfigured(), false);
  assert.equal(razorpay.verifyWebhookSignature(raw, signBody(raw)), false);

  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  assert.equal(razorpay.isWebhookConfigured(), true);
  assert.equal(razorpay.verifyWebhookSignature(raw, signBody(raw)), true);
  assert.equal(razorpay.verifyWebhookSignature(raw, signBody(raw, "other")), false);
  assert.equal(razorpay.verifyWebhookSignature(Buffer.from("tampered"), signBody(raw)), false);
  assert.equal(razorpay.verifyWebhookSignature(raw, undefined), false);

  if (saved === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
  else process.env.RAZORPAY_WEBHOOK_SECRET = saved;
});

test("webhook payment.captured settles an unpaid online order once, even if replayed", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });

  const first = await paymentService.settleWebhookPayment({
    razorpayOrderId: "order_RZP1",
    paymentId: "pay_WH",
    amountPaise: 123450,
  });
  assert.deepEqual(first, { handled: true, outcome: "paid" });
  assert.equal(orders[0].payment_status, "Paid");
  assert.equal(orders[0].status, "Confirmed");
  assert.equal(orders[0].payment_id, "pay_WH");
  assert.equal(variants[0].inventory, 3);

  // Razorpay retries deliveries: the second one must not take stock again.
  const again = await paymentService.settleWebhookPayment({
    razorpayOrderId: "order_RZP1",
    paymentId: "pay_WH",
    amountPaise: 123450,
  });
  assert.deepEqual(again, { handled: true, outcome: "already_paid" });
  assert.equal(variants[0].inventory, 3);
});

test("webhook with a different amount never settles the order", async () => {
  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });

  const result = await paymentService.settleWebhookPayment({
    razorpayOrderId: "order_RZP1",
    paymentId: "pay_WH",
    amountPaise: 100,
  });
  assert.deepEqual(result, { handled: false, reason: "amount_mismatch" });
  assert.notEqual(orders[0].payment_status, "Paid");
  assert.equal(variants[0].inventory, 5);
});

test("webhook for an unknown Razorpay order or missing ids is ignored", async () => {
  assert.deepEqual(
    await paymentService.settleWebhookPayment({ razorpayOrderId: "order_NOPE", paymentId: "pay_X", amountPaise: 1 }),
    { handled: false, reason: "unknown_order" }
  );
  assert.deepEqual(
    await paymentService.settleWebhookPayment({ razorpayOrderId: "", paymentId: "", amountPaise: 1 }),
    { handled: false, reason: "missing_ids" }
  );
});

test("webhook leaves a COD order untouched", async () => {
  orders[0].payment_method = "cod";
  orders[0].payment_order_id = "order_RZP1";
  const result = await paymentService.settleWebhookPayment({
    razorpayOrderId: "order_RZP1",
    paymentId: "pay_WH",
    amountPaise: 123450,
  });
  assert.deepEqual(result, { handled: false, reason: "not_online" });
  assert.notEqual(orders[0].payment_status, "Paid");
});


test("webhook endpoint: signed request settles the order, bad or missing signature does not", async () => {
  const http = require("http");
  const app = require("../app");
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

  await paymentService.createPaymentOrder({ userId: "u1", orderId: "o1" });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const post = (raw, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          port,
          path: "/api/payments/razorpay/webhook",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(raw), ...headers },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data || "{}") }));
        }
      );
      req.on("error", reject);
      req.end(raw);
    });

  try {
    const raw = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_HTTP", order_id: "order_RZP1", amount: 123450 } } },
    });

    // No signature and a wrong signature are rejected and change nothing.
    assert.equal((await post(raw)).status, 400);
    assert.equal((await post(raw, { "x-razorpay-signature": signBody(raw, "wrong") })).status, 400);
    assert.notEqual(orders[0].payment_status, "Paid");

    // Signed over the exact raw bytes: accepted, and replaying it is harmless.
    const ok = await post(raw, { "x-razorpay-signature": signBody(raw) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.outcome, "paid");
    assert.equal(orders[0].payment_status, "Paid");
    assert.equal(variants[0].inventory, 3);

    const replay = await post(raw, { "x-razorpay-signature": signBody(raw) });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.outcome, "already_paid");
    assert.equal(variants[0].inventory, 3);

    // Events that do not change an order are acknowledged and ignored.
    const other = JSON.stringify({ event: "payment.authorized" });
    const ignored = await post(other, { "x-razorpay-signature": signBody(other) });
    assert.equal(ignored.status, 200);
    assert.equal(ignored.body.ignored, "payment.authorized");

    // Without a configured secret nothing is processed.
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    assert.equal((await post(raw, { "x-razorpay-signature": signBody(raw) })).status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  }
});
