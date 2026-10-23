const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

process.env.RAZORPAY_KEY_ID = "rzp_test_unit";
process.env.RAZORPAY_KEY_SECRET = "unit_secret";

const root = path.join(__dirname, "..");
const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

const orders = [];
const orderItems = [];
const variants = [];
let snapshot = null;

// A real transaction holds the row lock (SELECT ... FOR UPDATE) until commit /
// rollback; this mutex gives the fake the same behaviour so the duplicate-
// request tests are meaningful.
let lockQueue = Promise.resolve();

const pool = {
  async execute(sql, p = []) {
    const t = norm(sql);

    if (t.startsWith("select") && t.includes("from orders where id = ?") && t.endsWith("for update")) {
      const ownerScoped = t.includes("and user_id = ?");
      return [orders.filter((o) => o.id === p[0] && (!ownerScoped || o.user_id === p[1]))];
    }
    if (t.startsWith("select id, order_number, status, payment_status, total_amount, updated_at from orders where id = ?")) {
      return [orders.filter((o) => o.id === p[0])];
    }
    if (t.startsWith("select status, payment_status from orders where id = ?")) {
      return [orders.filter((o) => o.id === p[0]).map((o) => ({ status: o.status, payment_status: o.payment_status }))];
    }
    if (t.includes("from orders where user_id = ?")) {
      return [orders.filter((o) => o.user_id === p[0]).map((o) => ({ ...o }))];
    }
    if (t.startsWith("select id, order_number, payment_id, total_amount from orders where lower(status) = 'cancelled'")) {
      return [
        orders.filter(
          (o) =>
            o.status.toLowerCase() === "cancelled" &&
            o.payment_status.toLowerCase() === "refund pending" &&
            o.payment_id
        ),
      ];
    }
    if (t.startsWith("update orders set payment_status = 'refunded'")) {
      const o = orders.find((x) => x.id === p[0] && x.payment_status === "Refund Pending");
      if (o) o.payment_status = "Refunded";
      return [{ affectedRows: o ? 1 : 0 }];
    }
    if (t.startsWith("select status, payment_method, payment_status from orders where id = ?")) {
      return [orders.filter((o) => o.id === p[0])];
    }
    if (t.startsWith("select variant_id, quantity from order_items")) {
      return [orderItems.filter((i) => i.order_id === p[0])];
    }
    if (t.startsWith("update product_variants set inventory = inventory + ?")) {
      variants.find((v) => v.id === p[1]).inventory += p[0];
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("update orders set status = 'cancelled'")) {
      orders.find((o) => o.id === p[0]).status = "Cancelled";
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("update orders set status = ?")) {
      orders.find((o) => o.id === p[1]).status = p[0];
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("update orders set payment_status = ?")) {
      orders.find((o) => o.id === p[1]).payment_status = p[0];
      return [{ affectedRows: 1 }];
    }
    throw new Error(`unhandled SQL: ${t}`);
  },
  async getConnection() {
    let release;
    const mine = new Promise((r) => (release = r));
    const previous = lockQueue;
    lockQueue = previous.then(() => mine);
    await previous;
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        release();
      }
    };
    return {
      execute: (sql, p) => pool.execute(sql, p),
      beginTransaction: async () => {
        snapshot = JSON.stringify({ variants, orders });
      },
      commit: async () => finish(),
      rollback: async () => {
        const saved = JSON.parse(snapshot);
        variants.splice(0, variants.length, ...saved.variants);
        orders.splice(0, orders.length, ...saved.orders);
        finish();
      },
      release: finish,
    };
  },
};

const sqlPath = require.resolve(path.join(root, "config", "sql"));
require.cache[sqlPath] = {
  id: sqlPath,
  filename: sqlPath,
  loaded: true,
  exports: { poolPromise: Promise.resolve(pool) },
};

const orderService = require("../services/order.service");
const {
  cancelOrder: cancelOrderController,
  retryCancellationRefund: retryController,
} = require("../controller/order.controller");

const BLOCKED =
  "Sorry, this order can no longer be cancelled because it has moved beyond the processing stage.";

let apiCalls;
let refundResponse;
let refundQueue; // one-shot responses consumed before `refundResponse`
let balancePaise; // what GET /balance reports; null = endpoint fails
let existingRefunds; // what GET /payments/:id/refunds reports
const realFetch = global.fetch;

const HTTP_400 = {
  ok: false,
  status: 400,
  body: {
    error: {
      code: "BAD_REQUEST_ERROR",
      description: "invalid request sent",
      field: null,
      reason: "NA",
      source: "NA",
      step: "NA",
      metadata: {},
    },
  },
};

const EXPLICIT_BALANCE_400 = {
  ok: false,
  status: 400,
  body: {
    error: {
      code: "BAD_REQUEST_ERROR",
      description: "Your account does not have enough balance to carry out the refund operation.",
    },
  },
};

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

const seed = (overrides = {}) => {
  orders.length = 0;
  orders.push({
    id: "o1",
    user_id: "u1",
    status: "Confirmed",
    payment_method: "cod",
    payment_status: "Pending",
    payment_id: null,
    total_amount: 1234.5,
    ...overrides,
  });
  orderItems.length = 0;
  orderItems.push({ order_id: "o1", variant_id: "v1", quantity: 2 });
  variants.length = 0;
  variants.push({ id: "v1", inventory: 5 });
};

const paidOnline = (status = "Confirmed", overrides = {}) =>
  seed({ status, payment_method: "online", payment_status: "Paid", payment_id: "pay_1", ...overrides });

const refundCalls = () => apiCalls.filter((c) => c.url.endsWith("/refund") && c.init.method === "POST");

test.beforeEach(() => {
  seed();
  apiCalls = [];
  refundQueue = [];
  existingRefunds = [];
  balancePaise = 100000000; // plenty by default
  refundResponse = { ok: true, body: { id: "rfnd_1", status: "processed" } };
  global.fetch = async (url, init) => {
    apiCalls.push({ url, init });
    const headers = { get: (h) => (h.toLowerCase() === "x-razorpay-request-id" ? "req_TEST123" : null) };

    if (url.endsWith("/balance")) {
      if (balancePaise === null) return { ok: false, status: 500, headers, json: async () => ({}) };
      return { ok: true, status: 200, headers, json: async () => ({ balance: balancePaise }) };
    }
    if (url.includes("/refunds") && init.method === "GET") {
      return { ok: true, status: 200, headers, json: async () => ({ items: existingRefunds }) };
    }
    if (url.endsWith("/refund")) {
      const queued = refundQueue.length ? refundQueue.shift() : refundResponse;
      return {
        ok: queued.ok,
        status: queued.ok ? 200 : queued.status || 400,
        headers,
        json: async () => queued.body,
      };
    }
    throw new Error(`unexpected ${url}`);
  };
});

test.after(() => {
  global.fetch = realFetch;
});

const cancelAs = (userId = "u1") => orderService.cancelOrder(userId, "o1");
const callController = async (userId = "u1") => {
  const res = fakeRes();
  await cancelOrderController({ params: { orderId: "o1" }, user: { id: userId } }, res);
  return res;
};
const captureLogs = async (fn) => {
  const originals = { error: console.error, warn: console.warn };
  const lines = [];
  console.error = (...a) => lines.push("ERROR " + a.join(" "));
  console.warn = (...a) => lines.push("WARN " + a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = originals.error;
    console.warn = originals.warn;
  }
};

// ---- status rules -----------------------------------------------------------

for (const status of ["Pending", "Confirmed", "Processing"]) {
  test(`customer can cancel a ${status} COD order; stock restored; no refund`, async () => {
    seed({ status });
    const result = await cancelAs();
    assert.equal(result.status, "Cancelled");
    assert.equal(result.refundStatus, "none");
    assert.equal(orders[0].status, "Cancelled");
    assert.equal(orders[0].payment_status, "Pending"); // COD payment state untouched
    assert.equal(variants[0].inventory, 7);
    assert.equal(apiCalls.length, 0, "COD must never call Razorpay");
  });
}

for (const status of ["Packed", "Shipped", "Delivered", "Returned"]) {
  test(`customer cannot cancel a ${status} order`, async () => {
    seed({ status });
    await assert.rejects(cancelAs(), (e) => {
      assert.equal(e.message, BLOCKED);
      assert.equal(e.statusCode, 409);
      return true;
    });
    assert.equal(orders[0].status, status);
    assert.equal(variants[0].inventory, 5);
    assert.equal(apiCalls.length, 0);
  });
}

test("an already Cancelled order is rejected and stock is not restored twice", async () => {
  seed({ status: "Cancelled" });
  await assert.rejects(cancelAs(), (e) => {
    assert.match(e.message, /already been cancelled/);
    assert.equal(e.statusCode, 409);
    return true;
  });
  assert.equal(variants[0].inventory, 5);
});

test("admin / system cancellation still allows a Packed order", async () => {
  seed({ status: "Packed" });
  const result = await orderService.cancelOrderById("o1");
  assert.equal(result.status, "Cancelled");
  assert.equal(variants[0].inventory, 7);
});

test("unpaid online order (Processing) cancels with no refund call and no stock change", async () => {
  seed({ status: "Processing", payment_method: "online", payment_status: "Pending" });
  const result = await cancelAs();
  assert.equal(result.refundStatus, "none");
  assert.equal(apiCalls.length, 0);
  assert.equal(variants[0].inventory, 5, "no stock was taken for an unpaid order");
});

// ---- ownership + duplicates ---------------------------------------------------

test("another user cannot cancel the order (looks like not found)", async () => {
  await assert.rejects(cancelAs("intruder"), (e) => {
    assert.equal(e.message, "Order not found.");
    assert.equal(e.statusCode, 404);
    return true;
  });
  assert.equal(orders[0].status, "Confirmed");
  assert.equal(variants[0].inventory, 5);
});

test("two simultaneous cancel requests: one wins, stock restored once", async () => {
  const results = await Promise.allSettled([cancelAs(), cancelAs()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.match(rejected.reason.message, /already been cancelled/);
  assert.equal(variants[0].inventory, 7);
});

test("two simultaneous cancels of a paid online order refund exactly once", async () => {
  paidOnline();
  const results = await Promise.allSettled([cancelAs(), cancelAs()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(refundCalls().length, 1);
});

// ---- successful refunds ---------------------------------------------------------

test("paid online order: refund processed -> Cancelled + Refunded, amount in paise, stock restored", async () => {
  paidOnline();
  const result = await cancelAs();
  assert.equal(result.status, "Cancelled");
  assert.equal(result.refundStatus, "processed");
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refunded");
  assert.equal(variants[0].inventory, 7);
  assert.equal(refundCalls().length, 1);
  assert.ok(refundCalls()[0].url.endsWith("/payments/pay_1/refund"));
  assert.equal(JSON.parse(refundCalls()[0].init.body).amount, 123450);
});

test("refund request: POST /payments/:id/refund with only an integer paise amount", async () => {
  // MySQL returns DECIMAL columns as strings
  paidOnline("Confirmed", { payment_id: "pay_TqwIPbQZWaU1x5", total_amount: "38199.00" });
  await cancelAs();

  assert.equal(refundCalls().length, 1);
  const { url, init } = refundCalls()[0];
  assert.equal(init.method, "POST");
  assert.equal(url, "https://api.razorpay.com/v1/payments/pay_TqwIPbQZWaU1x5/refund");
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body), ["amount"], "no unsupported/extra fields");
  assert.equal(body.amount, 3819900);
  assert.ok(Number.isInteger(body.amount));
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.match(init.headers.Authorization, /^Basic /);
});

test("a refund that is accepted but not yet processed: Cancelled, internally 'Refund Pending', never 'Refunded'", async () => {
  paidOnline("Processing");
  refundResponse = { ok: true, body: { id: "rfnd_2", status: "pending" } };
  const result = await cancelAs();
  assert.equal(result.refundStatus, "pending");
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refund Pending");

  // a repeat request is rejected and does not refund again
  const again = await callController();
  assert.equal(again.statusCode, 409);
  assert.equal(refundCalls().length, 1);
});

// ---- customer-facing output: only "Cancelled" -----------------------------------------

test("controller answers a plain 'Cancelled' for every refund outcome (no refund wording)", async () => {
  for (const refund of [
    { ok: true, body: { id: "r1", status: "processed" } },
    { ok: true, body: { id: "r2", status: "pending" } },
    HTTP_400,
  ]) {
    paidOnline();
    balancePaise = 1;
    refundResponse = refund;
    const { result: res } = await captureLogs(() => callController());
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, "Your order has been cancelled.");
    assert.deepEqual(res.body.order, { id: "o1", status: "Cancelled" });
    assert.doesNotMatch(JSON.stringify(res.body), /refund|pending|balance|BAD_REQUEST|invalid request/i);
  }
});

test("COD controller response mentions no refund and makes no Razorpay call", async () => {
  const res = await callController();
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body.message, /refund/i);
  assert.equal(apiCalls.length, 0);
});

test("blocked / foreign requests map to 409 / 404 at the controller", async () => {
  seed({ status: "Shipped" });
  let res = await callController();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.message, BLOCKED);

  seed();
  res = await callController("intruder");
  assert.equal(res.statusCode, 404);
});

test("customer order list never exposes Refund Pending / Refunded / Cancellation Requested", async () => {
  for (const [status, payment] of [
    ["Cancelled", "Refund Pending"],
    ["Cancelled", "Refunded"],
    ["Cancellation Requested", "Paid"],
  ]) {
    paidOnline(status, { payment_status: payment });
    const [row] = await orderService.getMyOrders("u1");
    assert.equal(row.status, "Cancelled");
    assert.equal(row.payment_status, "Cancelled");
  }

  // untouched for non-cancelled orders
  paidOnline("Confirmed");
  const [live] = await orderService.getMyOrders("u1");
  assert.equal(live.status, "Confirmed");
  assert.equal(live.payment_status, "Paid");

  // the admin record keeps the real state
  paidOnline("Cancelled", { payment_status: "Refund Pending" });
  assert.equal(orders[0].payment_status, "Refund Pending");
});

// ---- refund cannot be started now: cancel is still approved, refund is queued ----------

test("balance too low (generic 400 + confirmed shortfall): Cancelled, stock restored, refund queued as Refund Pending, NOT Refunded", async () => {
  // refund 3819900 paise; balance 3792722 paise (the real figures from the failing order)
  paidOnline("Processing", { payment_id: "pay_TqwIPbQZWaU1x5", total_amount: "38199.00" });
  balancePaise = 3792722;
  refundResponse = HTTP_400;

  const { result, lines } = await captureLogs(() => cancelAs());

  assert.equal(result.status, "Cancelled");
  assert.equal(result.refundStatus, "queued");
  assert.equal(result.refundId, null);
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refund Pending");
  assert.equal(variants[0].inventory, 7, "cancellation approved: stock restored");
  assert.ok(lines.some((l) => /DEFERRED \(insufficient Razorpay balance\)/.test(l) && /inferred from a generic HTTP 400/.test(l)));
  assert.ok(lines.some((l) => /Refund DEFERRED, kept as Refund Pending/.test(l)));
});

test("balance too low (Razorpay says so explicitly): also Cancelled + queued", async () => {
  paidOnline();
  refundResponse = EXPLICIT_BALANCE_400;
  const { result, lines } = await captureLogs(() => cancelAs());
  assert.equal(result.status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refund Pending");
  assert.ok(lines.some((l) => /stated by Razorpay/.test(l)));
});

test("repeating the cancel after it was queued is rejected and makes no second Razorpay attempt", async () => {
  paidOnline();
  balancePaise = 1;
  refundResponse = HTTP_400;
  await captureLogs(() => cancelAs());
  const attempts = refundCalls().length;

  await assert.rejects(cancelAs(), (e) => {
    assert.equal(e.statusCode, 409);
    assert.equal(e.code, "ALREADY_CANCELLED");
    return true;
  });
  assert.equal(refundCalls().length, attempts);
  assert.equal(variants[0].inventory, 7);
});

test("two simultaneous customer cancels of a low-balance order: one wins, stock restored once", async () => {
  paidOnline();
  balancePaise = 1;
  refundResponse = HTTP_400;
  const { result } = await captureLogs(() => Promise.allSettled([cancelAs(), cancelAs()]));
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(refundCalls().length, 1);
  assert.equal(variants[0].inventory, 7);
});

test("a generic HTTP 400 is NOT assumed to be a balance problem (still cancelled + queued, logged as a rejection)", async () => {
  paidOnline();
  balancePaise = 999999999;
  refundResponse = HTTP_400;
  const { lines } = await captureLogs(async () => {
    await cancelAs();
  });
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refund Pending");
  assert.equal(lines.some((l) => /DEFERRED \(insufficient/.test(l)), false);
  assert.ok(lines.some((l) => /REJECTED \(not a balance problem\)/.test(l)));
});

test("other Razorpay rejections are logged with the full structured error (no secrets)", async () => {
  paidOnline();
  refundResponse = {
    ok: false,
    status: 400,
    body: { error: { code: "BAD_REQUEST_ERROR", description: "Refund is not supported by the bank because the payment is more than 6 months old", field: null, reason: "NA", source: "NA", step: "NA", metadata: {} } },
  };
  const { lines } = await captureLogs(() => cancelAs());
  const line = lines.find((l) => /REJECTED \(not a balance problem\)/.test(l));
  assert.ok(line);
  const logged = JSON.parse(line.slice(line.indexOf("{")));
  assert.equal(logged.httpStatus, 400);
  assert.match(logged.description, /6 months old/);
  assert.deepEqual(logged.request.body, { amount: 123450 });
  assert.equal(line.includes("unit_secret"), false);
  assert.equal(orders[0].payment_status, "Refund Pending");
});

test("refund API 5xx: cancelled, refund queued for retry", async () => {
  paidOnline();
  refundResponse = { ok: false, status: 502, body: {} };
  await captureLogs(() => cancelAs());
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refund Pending");
  assert.equal(variants[0].inventory, 7);
});

test("a refund Razorpay marks failed is never recorded as refunded: queued for retry", async () => {
  paidOnline();
  refundResponse = { ok: true, body: { id: "rfnd_3", status: "failed" } };
  await captureLogs(() => cancelAs());
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refund Pending");
});

test("a missing payment reference still blocks the cancel (nothing to refund against)", async () => {
  paidOnline("Confirmed", { payment_id: null });
  await assert.rejects(cancelAs(), (e) => e.code === "PAYMENT_REFERENCE_MISSING");
  assert.equal(orders[0].status, "Confirmed");
  assert.equal(apiCalls.length, 0);
});

// ---- admin: retry a queued refund -----------------------------------------------------------

const queuedOrder = async (overrides = {}) => {
  paidOnline("Processing", { payment_id: "pay_TqwIPbQZWaU1x5", total_amount: "38199.00", ...overrides });
  balancePaise = 3792722;
  refundResponse = HTTP_400;
  await captureLogs(() => cancelAs());
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refund Pending");
  apiCalls.length = 0;
};

const retryAsAdmin = async () => {
  const res = fakeRes();
  await captureLogs(() => retryController({ params: { orderId: "o1" } }, res));
  return res;
};

test("admin retry while the balance is still short: 409 with the figures, stays Refund Pending, no stock change", async () => {
  await queuedOrder();
  const res = await retryAsAdmin();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "INSUFFICIENT_BALANCE");
  assert.match(res.body.message, /₹37,927\.22 is lower than this refund \(₹38,199\.00\)/);
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refund Pending");
  assert.equal(variants[0].inventory, 7);
});

test("admin retry after funds are added: one refund, Refunded, stock NOT restored again", async () => {
  await queuedOrder();
  balancePaise = 99999999; // topped up
  refundResponse = { ok: true, body: { id: "rfnd_ok", status: "processed" } };

  const res = await retryAsAdmin();
  assert.equal(res.statusCode, 200);
  assert.match(res.body.message, /Refund processed by Razorpay/);
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refunded");
  assert.equal(variants[0].inventory, 7);
  assert.equal(refundCalls().length, 1);

  // retrying again is rejected and creates no second refund
  const again = await retryAsAdmin();
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.code, "NO_PENDING_REFUND");
  assert.equal(refundCalls().length, 1);
  assert.equal(variants[0].inventory, 7);
});

test("admin retry with a refund Razorpay only accepted (pending): stays Refund Pending, not Refunded", async () => {
  await queuedOrder();
  balancePaise = 99999999;
  refundResponse = { ok: true, body: { id: "rfnd_p", status: "pending" } };
  const result = await orderService.retryCancellationRefund("o1");
  assert.equal(result.status, "Cancelled");
  assert.equal(result.refundStatus, "pending");
  assert.equal(orders[0].payment_status, "Refund Pending");
  assert.equal(refundCalls().length, 1);
});

test("two simultaneous admin retries create exactly one refund", async () => {
  await queuedOrder();
  balancePaise = 99999999;
  refundResponse = { ok: true, body: { id: "rfnd_ok", status: "processed" } };
  const results = await Promise.allSettled([
    orderService.retryCancellationRefund("o1"),
    orderService.retryCancellationRefund("o1"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(refundCalls().length, 1);
  assert.equal(orders[0].payment_status, "Refunded");
});

test("admin retry reconciles first: a refund Razorpay already processed is adopted, no new refund (the ₹1,355 case)", async () => {
  paidOnline("Cancelled", { payment_status: "Refund Pending", total_amount: "1355.00" });
  existingRefunds = [{ id: "rfnd_done", amount: 135500, status: "processed" }];
  const result = await orderService.retryCancellationRefund("o1");
  assert.equal(refundCalls().length, 0, "no second refund");
  assert.equal(result.refundId, "rfnd_done");
  assert.equal(orders[0].payment_status, "Refunded");
  assert.equal(variants[0].inventory, 5, "stock untouched");
});

test("admin retry with a refund Razorpay still holds as pending: adopted, not repeated, not Refunded", async () => {
  paidOnline("Cancelled", { payment_status: "Refund Pending", total_amount: "1355.00" });
  existingRefunds = [{ id: "rfnd_wait", amount: 135500, status: "pending" }];
  await orderService.retryCancellationRefund("o1");
  assert.equal(refundCalls().length, 0);
  assert.equal(orders[0].payment_status, "Refund Pending");
});

test("admin retry only works on a pending refund (and 404s for unknown orders)", async () => {
  seed({ status: "Confirmed" });
  await assert.rejects(orderService.retryCancellationRefund("o1"), (e) => {
    assert.equal(e.code, "NO_PENDING_CANCELLATION");
    assert.equal(e.statusCode, 409);
    return true;
  });
  seed({ status: "Cancelled" }); // COD: nothing was collected, nothing to refund
  await assert.rejects(orderService.retryCancellationRefund("o1"), (e) => e.code === "NO_PENDING_REFUND");
  await assert.rejects(orderService.retryCancellationRefund("nope"), (e) => e.statusCode === 404);
  assert.equal(apiCalls.length, 0);
});

test("legacy 'Cancellation Requested' order: admin retry completes it once (cancel + stock once + one refund)", async () => {
  paidOnline("Cancellation Requested", { payment_id: "pay_TqwIPbQZWaU1x5", total_amount: "38199.00" });
  balancePaise = 99999999;
  refundResponse = { ok: true, body: { id: "rfnd_ok", status: "processed" } };

  const [shown] = await orderService.getMyOrders("u1");
  assert.equal(shown.status, "Cancelled", "customer already sees Cancelled");

  await orderService.retryCancellationRefund("o1");
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refunded");
  assert.equal(variants[0].inventory, 7);
  assert.equal(refundCalls().length, 1);

  await assert.rejects(orderService.retryCancellationRefund("o1"), (e) => e.code === "NO_PENDING_REFUND");
  assert.equal(refundCalls().length, 1);
});

test("admin setting status Cancelled on a low-balance order cancels it and queues the refund", async () => {
  paidOnline("Processing", { total_amount: "38199.00" });
  balancePaise = 1;
  refundResponse = HTTP_400;
  await captureLogs(() => orderService.updateOrderStatus("o1", "Cancelled"));
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refund Pending");
  await assert.rejects(orderService.updateOrderStatus("o1", "Shipped"), /cancelled order cannot be changed/);
});

// ---- reconciliation (read-only against Razorpay) ---------------------------------------------

test("reconcile marks Refunded only when Razorpay shows a full refund processed", async () => {
  paidOnline("Cancelled", { payment_status: "Refund Pending", total_amount: "1355.00" });
  existingRefunds = [{ id: "rfnd_done", amount: 135500, status: "processed" }];

  const dry = await orderService.reconcilePendingRefunds({ apply: false });
  assert.equal(dry[0].outcome, "would_mark_refunded");
  assert.equal(orders[0].payment_status, "Refund Pending", "dry run writes nothing");

  const done = await orderService.reconcilePendingRefunds();
  assert.equal(done[0].outcome, "marked_refunded");
  assert.equal(orders[0].payment_status, "Refunded");
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(variants[0].inventory, 5, "stock untouched");
  assert.equal(refundCalls().length, 0, "reconcile never creates a refund");
});

test("reconcile leaves pending / partial / failed / missing / unreadable refunds as Refund Pending", async () => {
  const cases = [
    [{ id: "a", amount: 135500, status: "pending" }],
    [{ id: "b", amount: 50000, status: "processed" }],
    [{ id: "c", amount: 135500, status: "failed" }],
    [{ id: "d", amount: 135500, status: "processed" }, { id: "e", amount: 135500, status: "pending" }].slice(1),
    [],
  ];
  for (const refunds of cases) {
    paidOnline("Cancelled", { payment_status: "Refund Pending", total_amount: "1355.00" });
    existingRefunds = refunds;
    const report = await orderService.reconcilePendingRefunds();
    assert.equal(report[0].outcome, "unchanged");
    assert.equal(orders[0].payment_status, "Refund Pending");
  }
  assert.equal(refundCalls().length, 0);
});

test("reconcile ignores orders that are not Cancelled + Refund Pending (COD, Paid, Refunded)", async () => {
  seed({ status: "Cancelled" }); // COD
  assert.deepEqual(await orderService.reconcilePendingRefunds(), []);
  paidOnline("Cancelled", { payment_status: "Refunded" });
  assert.deepEqual(await orderService.reconcilePendingRefunds(), []);
  assert.equal(apiCalls.length, 0);
});

// ---- duplicate-refund prevention against Razorpay's own state --------------------------

test("a full refund already held by Razorpay (processed) is adopted, never repeated", async () => {
  paidOnline("Confirmed", { total_amount: "1234.50" });
  existingRefunds = [{ id: "rfnd_old", amount: 123450, status: "processed" }];
  const result = await cancelAs();
  assert.equal(refundCalls().length, 0, "no second refund created");
  assert.equal(result.status, "Cancelled");
  assert.equal(result.refundId, "rfnd_old");
  assert.equal(orders[0].payment_status, "Refunded");
  assert.equal(variants[0].inventory, 7);
});

test("a full refund already held by Razorpay (pending) is adopted as 'Refund Pending'", async () => {
  paidOnline("Confirmed", { total_amount: "1234.50" });
  existingRefunds = [{ id: "rfnd_old", amount: 123450, status: "pending" }];
  const result = await cancelAs();
  assert.equal(refundCalls().length, 0);
  assert.equal(result.refundStatus, "pending");
  assert.equal(orders[0].payment_status, "Refund Pending");
});

test("a failed earlier refund does not count as refunded; a new one is created", async () => {
  paidOnline("Confirmed", { total_amount: "1234.50" });
  existingRefunds = [{ id: "rfnd_bad", amount: 123450, status: "failed" }];
  await cancelAs();
  assert.equal(refundCalls().length, 1);
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refunded");
});

test("a PARTIAL refund already on the payment: cancelled, no automatic refund, queued for manual review", async () => {
  paidOnline("Confirmed", { total_amount: "1234.50" });
  existingRefunds = [{ id: "rfnd_part", amount: 50000, status: "processed" }];
  await captureLogs(() => cancelAs());
  assert.equal(refundCalls().length, 0);
  assert.equal(orders[0].status, "Cancelled");
  assert.equal(orders[0].payment_status, "Refund Pending");

  const res = await retryAsAdmin();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "PARTIAL_REFUND_EXISTS");
  assert.equal(refundCalls().length, 0);
});

test("Razorpay says it is already fully refunded (but the list was unreadable): adopted as pending, never 'processed'", async () => {
  paidOnline();
  refundResponse = {
    ok: false,
    status: 400,
    body: { error: { code: "BAD_REQUEST_ERROR", description: "The payment has been fully refunded already" } },
  };
  const { result } = await captureLogs(() => cancelAs());
  assert.equal(result.status, "Cancelled");
  assert.equal(result.refundStatus, "pending");
  assert.equal(orders[0].payment_status, "Refund Pending");
  assert.equal(variants[0].inventory, 7);
});
