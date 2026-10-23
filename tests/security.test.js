// Security regression tests. They drive the REAL Express app (real routers,
// authentication / role middleware, controllers and services) over HTTP.
// Only two things are simulated: the database (in memory) and Razorpay - any
// call to Razorpay fails the test run, so no payment or refund is ever made.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "test-secret-not-used-anywhere-else";
process.env.RAZORPAY_KEY_ID = "rzp_test_unit";
process.env.RAZORPAY_KEY_SECRET = "unit_secret";
delete process.env.CORS_ORIGINS;

const root = path.join(__dirname, "..");
const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

// ---------------------------------------------------------------- accounts --
const ids = {
  alice: "user-alice",
  bob: "user-bob",
  admin: "user-admin",
  superadmin: "user-super",
  inactive: "user-inactive",
  demoted: "user-demoted", // was an admin; the database now says customer
};

const users = [
  { id: ids.alice, email: "alice@example.com", role: "customer", is_active: 1, full_name: "Alice" },
  { id: ids.bob, email: "bob@example.com", role: "customer", is_active: 1, full_name: "Bob" },
  { id: ids.admin, email: "admin@example.com", role: "admin", is_active: 1, full_name: "Admin" },
  { id: ids.superadmin, email: "owner@example.com", role: "superadmin", is_active: 1, full_name: "Owner" },
  { id: ids.inactive, email: "gone@example.com", role: "customer", is_active: 0, full_name: null },
  { id: ids.demoted, email: "demoted@example.com", role: "customer", is_active: 1, full_name: "Demoted" },
];

// ------------------------------------------------------------- fake database --
const orders = [];
const addresses = [];
const cartItems = [];
const subscriptions = [];
const queries = [];
let failOrderQueries = false;
let beforeStatusUpdate = null;
const resetData = () => {
  orders.length = 0;
  addresses.length = 0;
  cartItems.length = 0;
  subscriptions.length = 0;
  orders.push(
    { id: "order-alice-cod", user_id: ids.alice, order_number: "ARD-1", status: "Confirmed", payment_method: "cod", payment_status: "Pending", total_amount: 1000, payment_id: null, payment_order_id: null },
    { id: "order-alice-online", user_id: ids.alice, order_number: "ARD-2", status: "Processing", payment_method: "online", payment_status: "Pending", total_amount: 1500, payment_id: null, payment_order_id: "order_RZP1" },
    { id: "order-bob", user_id: ids.bob, order_number: "ARD-3", status: "Confirmed", payment_method: "cod", payment_status: "Pending", total_amount: 700, payment_id: null, payment_order_id: null },
    { id: "order-refunded", user_id: ids.alice, order_number: "ARD-4", status: "Cancelled", payment_method: "online", payment_status: "Refunded", total_amount: 900, payment_id: "pay_done", payment_order_id: "order_RZP9" }
  );
  addresses.push({ id: "addr-alice", user_id: ids.alice, name: "Alice" });
  cartItems.push({ id: "item-alice", user_id: ids.alice, quantity: 1 });
  subscriptions.push({ id: "sub-alice", user_id: ids.alice, status: "pending" });
};

const rules = [
  [/from profiles where id = \?/, (p) => users.filter((u) => u.id === p[0])],
  [/from profiles where email = \?/, () => []],
  [/^update profiles set full_name = \?/, (p) => {
    const user = users.find((u) => u.id === p[3]);
    if (user) user.full_name = p[0];
    return { affectedRows: user ? 1 : 0 };
  }],
  [/from orders where user_id = \? order by/, (p) => {
    if (failOrderQueries) {
      const error = new Error("You have an error in your SQL syntax near 'orders'");
      error.code = "ER_PARSE_ERROR";
      error.sqlMessage = "Table 'ardenby.orders' secret detail";
      throw error;
    }
    return orders.filter((o) => o.user_id === p[0]);
  }],
  [/from orders where id = \? and user_id = \? limit 1 for update/, (p) =>
    orders.filter((o) => o.id === p[0] && o.user_id === p[1])],
  [/from orders where id = \? and user_id = \?/, (p) =>
    orders.filter((o) => o.id === p[0] && o.user_id === p[1])],
  [/^select status, payment_status from orders where id = \?/, (p) =>
    orders.filter((o) => o.id === p[0])],
  [/from orders order by created_at desc/, () => []],
  [/^select status, payment_method, payment_status from orders where id = \?/, (p) =>
    orders.filter((o) => o.id === p[0])],
  [/^select id, order_number, status, payment_status, total_amount, updated_at from orders where id = \?/, (p) =>
    orders.filter((o) => o.id === p[0])],
  [/^update orders set status = \?, payment_status = case/, (p) => {
    if (beforeStatusUpdate) {
      const hook = beforeStatusUpdate;
      beforeStatusUpdate = null;
      hook(); // a customer cancel lands between the admin's read and write
    }
    const order = orders.find((o) => o.id === p[2] && o.status === p[3]);
    if (order) order.status = p[0];
    return { affectedRows: order ? 1 : 0 };
  }],
  [/from order_items where order_id = \?/, () => []],
  [/^update orders set status = 'cancelled', updated_at/, (p) => {
    const order = orders.find((o) => o.id === p[0]);
    if (order) order.status = "Cancelled";
    return { affectedRows: order ? 1 : 0 };
  }],
  [/^update orders set payment_status = 'failed'/, (p) => {
    const order = orders.find((o) => o.id === p[0] && o.user_id === p[1] && String(o.payment_status).toLowerCase() === "pending");
    if (order) order.payment_status = "Failed";
    return { affectedRows: order ? 1 : 0 };
  }],
  [/from addresses where id = \? and user_id = \?/, (p) =>
    addresses.filter((a) => a.id === p[0] && a.user_id === p[1])],
  [/from cart_items ci inner join carts c .*where ci\.id = \? and c\.user_id = \?/, (p) =>
    cartItems.filter((i) => i.id === p[0] && i.user_id === p[1])],
  [/from subscriptions where id = \? and user_id = \?/, (p) =>
    subscriptions.filter((s) => s.id === p[0] && s.user_id === p[1])],
  [/from coupons/, () => []],
  [/from products/, (p) => (p.length ? [] : [])],
];

let lastProductParams = null;

const execute = async (sql, params = []) => {
  const text = norm(sql);
  queries.push({ text, params });

  if (text.includes("from products") && text.includes("limit ? offset ?")) {
    lastProductParams = params;
  }
  if (text.includes("count(")) return [[{ total: 0 }]];

  for (const [pattern, handler] of rules) {
    if (pattern.test(text)) return [JSON.parse(JSON.stringify(handler(params)))];
  }
  throw new Error(`security.test fake DB: unhandled SQL: ${text}`);
};

const pool = {
  execute,
  async getConnection() {
    return {
      execute,
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
    };
  },
};

const sqlPath = require.resolve(path.join(root, "config", "sql"));
require.cache[sqlPath] = {
  id: sqlPath,
  filename: sqlPath,
  loaded: true,
  exports: { poolPromise: Promise.resolve(pool), testDatabaseConnection: async () => {} },
};

// ----------------------------------------------- Razorpay must never be called --
const realFetch = globalThis.fetch;
const razorpayCalls = [];
globalThis.fetch = (url, options) => {
  if (String(url).includes("razorpay.com")) {
    razorpayCalls.push(String(url));
    throw new Error("Razorpay must not be called from security tests.");
  }
  return realFetch(url, options);
};

const originalError = console.error;
const originalWarn = console.warn;
console.error = () => undefined; // expected rejections log noise
console.warn = () => undefined;

const app = require(path.join(root, "app"));
let server;
let base;

test.before(async () => {
  resetData();
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  console.error = originalError;
  console.warn = originalWarn;
  globalThis.fetch = realFetch;
});

test.beforeEach(() => {
  resetData();
  failOrderQueries = false;
  beforeStatusUpdate = null;
  queries.length = 0;
});

// ------------------------------------------------------------------ helpers --
const tokenFor = (id, role, extra = {}, options = { expiresIn: "1h" }) =>
  jwt.sign({ id, email: `${id}@x.test`, role, ...extra }, process.env.JWT_SECRET, options);

const tokens = {
  alice: () => tokenFor(ids.alice, "customer"),
  bob: () => tokenFor(ids.bob, "customer"),
  admin: () => tokenFor(ids.admin, "admin"),
  superadmin: () => tokenFor(ids.superadmin, "superadmin"),
};

const call = async (method, url, { token, body, headers = {}, raw } = {}) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(body && !raw ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, body: data, headers: response.headers };
};

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

// Every endpoint that needs an account. [method, path, who may use it]
const CUSTOMER_ROUTES = [
  ["GET", "/api/cart"],
  ["POST", "/api/cart"],
  ["POST", "/api/cart/items"],
  ["PUT", "/api/cart/items/item-alice"],
  ["DELETE", "/api/cart/items/item-alice"],
  ["DELETE", "/api/cart"],
  ["PATCH", "/api/cart/coupon"],
  ["GET", "/api/addresses"],
  ["GET", "/api/addresses/addr-alice"],
  ["POST", "/api/addresses"],
  ["PUT", "/api/addresses/addr-alice"],
  ["PATCH", "/api/addresses/addr-alice/default"],
  ["DELETE", "/api/addresses/addr-alice"],
  ["GET", "/api/wishlist"],
  ["POST", "/api/wishlist"],
  ["GET", "/api/wishlist/check/p1"],
  ["DELETE", "/api/wishlist/p1"],
  ["DELETE", "/api/wishlist"],
  ["POST", "/api/orders"],
  ["GET", "/api/orders/my"],
  ["GET", "/api/orders/order-alice-cod"],
  ["PATCH", "/api/orders/order-alice-cod/cancel"],
  ["POST", "/api/payments/razorpay/order"],
  ["POST", "/api/payments/razorpay/verify"],
  ["POST", "/api/payments/razorpay/failed"],
  ["POST", "/api/payments/razorpay/sync"],
  ["GET", "/api/subscriptions/my"],
  ["GET", "/api/subscriptions/active"],
  ["POST", "/api/subscriptions"],
  ["PATCH", "/api/subscriptions/sub-alice/cancel"],
];

const ACCOUNT_ROUTES = [
  ["GET", "/api/users/me"],
  ["PUT", "/api/users/me"],
  ["PUT", "/api/users/me/password"],
  ["DELETE", "/api/users/me"],
  ["GET", "/api/coupons/available"],
  ["POST", "/api/coupons/validate"],
];

const ADMIN_ROUTES = [
  ["GET", "/api/orders/admin/all"],
  ["PATCH", "/api/orders/admin/order-alice-cod/status"],
  ["PATCH", "/api/orders/admin/order-alice-cod/retry-refund"],
  ["POST", "/api/products"],
  ["PUT", "/api/products/p1"],
  ["DELETE", "/api/products/p1"],
  ["GET", "/api/products/test-role"],
  ["POST", "/api/categories"],
  ["PUT", "/api/categories/shirts"],
  ["DELETE", "/api/categories/shirts"],
  ["GET", "/api/coupons"],
  ["GET", "/api/coupons/SAVE10"],
  ["POST", "/api/coupons"],
  ["PUT", "/api/coupons/c1"],
  ["DELETE", "/api/coupons/c1"],
  ["PATCH", "/api/subscriptions/sub-alice/activate"],
];

// ===================================================================== 401 ==
test("unauthenticated requests get 401 on every protected endpoint", async () => {
  for (const [method, url] of [...CUSTOMER_ROUTES, ...ACCOUNT_ROUTES, ...ADMIN_ROUTES]) {
    const res = await call(method, url, { body: method === "GET" ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${url} should be 401, got ${res.status}`);
  }
});

test("malformed, expired, forged and wrong-type tokens are rejected with 401", async () => {
  const bad = {
    "garbage": "not-a-jwt",
    "wrong signature": jwt.sign({ id: ids.admin, role: "admin" }, "some-other-secret"),
    "expired": tokenFor(ids.admin, "admin", {}, { expiresIn: -60 }),
    "alg none": `${b64({ alg: "none", typ: "JWT" })}.${b64({ id: ids.admin, role: "admin" })}.`,
    "password-reset token used as a session": tokenFor(ids.alice, undefined, { purpose: "password_reset" }),
    "no id claim": jwt.sign({ role: "admin" }, process.env.JWT_SECRET),
  };

  for (const [label, token] of Object.entries(bad)) {
    for (const url of ["/api/users/me", "/api/orders/admin/all", "/api/orders/my"]) {
      const res = await call("GET", url, { token });
      assert.equal(res.status, 401, `${label} on ${url} should be 401, got ${res.status}`);
    }
  }

  const noBearer = await call("GET", "/api/users/me", { headers: { Authorization: tokens.alice() } });
  assert.equal(noBearer.status, 401);
});

test("expired tokens say so", async () => {
  const res = await call("GET", "/api/users/me", { token: tokenFor(ids.alice, "customer", {}, { expiresIn: -5 }) });
  assert.equal(res.status, 401);
  assert.match(res.body.message, /expired/i);
});

test("an account that was deactivated or deleted loses access immediately", async () => {
  const inactive = await call("GET", "/api/users/me", { token: tokenFor(ids.inactive, "customer") });
  assert.equal(inactive.status, 401);

  const deleted = await call("GET", "/api/users/me", { token: tokenFor("user-does-not-exist", "customer") });
  assert.equal(deleted.status, 401);
});

// ===================================================================== 403 ==
test("a signed-in customer gets 403 on every admin endpoint", async () => {
  for (const [method, url] of ADMIN_ROUTES) {
    const res = await call(method, url, { token: tokens.alice(), body: method === "GET" ? undefined : {} });
    assert.equal(res.status, 403, `${method} ${url} should be 403 for a customer, got ${res.status}`);
  }
});

test("a token that still says 'admin' is useless once the database says customer", async () => {
  const stale = tokenFor(ids.demoted, "admin");

  for (const [method, url] of [
    ["GET", "/api/orders/admin/all"],
    ["PATCH", "/api/orders/admin/order-alice-cod/retry-refund"],
    ["GET", "/api/products/test-role"],
  ]) {
    const res = await call(method, url, { token: stale, body: method === "GET" ? undefined : {} });
    assert.equal(res.status, 403, `${method} ${url} with a stale admin claim, got ${res.status}`);
  }
});

test("a forged role claim cannot turn a customer into an admin", async () => {
  // Signed with the real secret but claiming admin for a customer's id.
  const res = await call("GET", "/api/orders/admin/all", { token: tokenFor(ids.alice, "superadmin") });
  assert.equal(res.status, 403);
});

test("customer-only endpoints refuse admin accounts (they are not shoppers)", async () => {
  for (const [method, url] of [["GET", "/api/cart"], ["GET", "/api/orders/my"], ["POST", "/api/payments/razorpay/order"]]) {
    const res = await call(method, url, { token: tokens.admin(), body: method === "GET" ? undefined : {} });
    assert.equal(res.status, 403, `${method} ${url}`);
  }
});

// ============================================================ admin access ==
test("the existing admin and super admin accounts are let through", async () => {
  for (const token of [tokens.admin(), tokens.superadmin()]) {
    assert.equal((await call("GET", "/api/products/test-role", { token })).status, 200);
    assert.equal((await call("GET", "/api/orders/admin/all", { token })).status, 200);
    assert.equal((await call("GET", "/api/coupons", { token })).status, 200);

    const me = await call("GET", "/api/users/me", { token });
    assert.equal(me.status, 200);
    assert.ok(["admin", "superadmin"].includes(me.body.user.role));
  }
});

test("an admin session survives repeated calls (page refresh / direct URL)", async () => {
  const token = tokens.admin();
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await call("GET", "/api/users/me", { token })).status, 200);
  }
});

test("admin tokens are short-lived (24h), customer tokens are not", () => {
  // generateToken is internal to the auth service; check the lifetime it signs with.
  const authService = require(path.join(root, "services", "auth.service"));
  assert.equal(typeof authService.verifyUserOTP, "function");
  const source = require("fs").readFileSync(path.join(root, "services", "auth.service.js"), "utf8");
  assert.match(source, /\["admin", "superadmin"\]\.includes\(user\.role\) \? "24h" : "7d"/);
});

// ============================================== customer-to-customer isolation ==
test("a customer cannot read another customer's order by changing the id", async () => {
  const own = await call("GET", "/api/orders/order-alice-cod", { token: tokens.alice() });
  assert.equal(own.status, 200);
  assert.equal(own.body.order.id, "order-alice-cod");
  assert.equal(own.body.order.user_id, undefined, "internal account id must not be returned");

  const stolen = await call("GET", "/api/orders/order-alice-cod", { token: tokens.bob() });
  assert.equal(stolen.status, 404);
  assert.equal(stolen.body.order, undefined);

  const mine = await call("GET", "/api/orders/my", { token: tokens.bob() });
  assert.deepEqual(mine.body.orders.map((o) => o.id), ["order-bob"]);
});

test("a customer cannot cancel another customer's order", async () => {
  const res = await call("PATCH", "/api/orders/order-alice-cod/cancel", { token: tokens.bob() });
  assert.equal(res.status, 404);
  assert.equal(orders.find((o) => o.id === "order-alice-cod").status, "Confirmed");
});

test("repeating a cancel does not cancel (or refund) twice", async () => {
  const first = await call("PATCH", "/api/orders/order-alice-cod/cancel", { token: tokens.alice() });
  assert.equal(first.status, 200);

  const second = await call("PATCH", "/api/orders/order-alice-cod/cancel", { token: tokens.alice() });
  assert.equal(second.status, 409);
  assert.equal(razorpayCalls.length, 0);
});

test("addresses, cart lines and subscriptions are scoped to their owner", async () => {
  assert.equal((await call("GET", "/api/addresses/addr-alice", { token: tokens.alice() })).status, 200);

  for (const [method, url, body] of [
    ["GET", "/api/addresses/addr-alice"],
    ["PUT", "/api/addresses/addr-alice", { name: "Mallory", phone: "9999999999", pincode: "400001", address: "x", city: "x", state: "x" }],
    ["PATCH", "/api/addresses/addr-alice/default"],
    ["DELETE", "/api/addresses/addr-alice"],
    ["PUT", "/api/cart/items/item-alice", { quantity: 5 }],
    ["DELETE", "/api/cart/items/item-alice"],
    ["PATCH", "/api/subscriptions/sub-alice/cancel"],
  ]) {
    const res = await call(method, url, { token: tokens.bob(), body: method === "GET" ? undefined : body || {} });
    assert.ok(res.status >= 400 && res.status < 500, `${method} ${url} by another customer should be refused, got ${res.status}`);
  }

  assert.equal(addresses.length, 1, "address must still exist");
  assert.equal(cartItems.length, 1, "cart line must still exist");
  assert.equal(cartItems[0].quantity, 1, "cart line must be unchanged");
});

test("user ids and roles sent in the body or query are ignored", async () => {
  const res = await call("PUT", `/api/users/me?id=${ids.bob}`, {
    token: tokens.alice(),
    body: { id: ids.admin, role: "superadmin", is_active: 0, email: "evil@example.com", fullName: "Alice B" },
  });
  assert.equal(res.status, 200);

  const alice = users.find((u) => u.id === ids.alice);
  assert.equal(alice.role, "customer");
  assert.equal(alice.email, "alice@example.com");
  assert.equal(users.find((u) => u.id === ids.bob).full_name, "Bob");
  assert.equal(
    queries.some((q) => q.text.startsWith("update profiles") && /role|is_active|email/.test(q.text.split(" where ")[0])),
    false,
    "profile update must not write role / is_active / email"
  );
});

// ============================================================ payments/refund ==
test("payments: another customer's order cannot be paid, verified, failed or synced", async () => {
  for (const [url, body] of [
    ["/api/payments/razorpay/order", { orderId: "order-alice-online" }],
    ["/api/payments/razorpay/verify", { orderId: "order-alice-online", razorpay_order_id: "order_RZP1", razorpay_payment_id: "pay_1", razorpay_signature: "x" }],
    ["/api/payments/razorpay/sync", { orderId: "order-alice-online" }],
  ]) {
    const res = await call("POST", url, { token: tokens.bob(), body });
    assert.equal(res.status, 400, url);
    assert.match(res.body.message, /not found/i, url);
  }

  // "Failed" is a no-op for an order that is not yours: the update is scoped to the caller.
  await call("POST", "/api/payments/razorpay/failed", { token: tokens.bob(), body: { orderId: "order-alice-online" } });

  assert.equal(orders.find((o) => o.id === "order-alice-online").payment_status, "Pending");
  assert.equal(razorpayCalls.length, 0);
});

test("payments: a forged signature never marks an order paid", async () => {
  const forged = crypto.createHmac("sha256", "wrong-secret").update("order_RZP1|pay_attack").digest("hex");

  for (const signature of [forged, "deadbeef", "x".repeat(64)]) {
    const res = await call("POST", "/api/payments/razorpay/verify", {
      token: tokens.alice(),
      body: { orderId: "order-alice-online", razorpay_order_id: "order_RZP1", razorpay_payment_id: "pay_attack", razorpay_signature: signature },
    });
    assert.equal(res.status, 400);
  }

  const order = orders.find((o) => o.id === "order-alice-online");
  assert.notEqual(String(order.payment_status).toLowerCase(), "paid");
  assert.equal(order.status, "Processing");
});

test("payments: a payment for a different Razorpay order is refused", async () => {
  const sig = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update("order_OTHER|pay_1").digest("hex");
  const res = await call("POST", "/api/payments/razorpay/verify", {
    token: tokens.alice(),
    body: { orderId: "order-alice-online", razorpay_order_id: "order_OTHER", razorpay_payment_id: "pay_1", razorpay_signature: sig },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /does not match/i);
});

test("payments: client-supplied amounts and statuses are not accepted", async () => {
  const res = await call("POST", "/api/payments/razorpay/verify", {
    token: tokens.alice(),
    body: { orderId: "order-alice-online", amount: 1, status: "paid", payment_status: "Paid" },
  });
  assert.equal(res.status, 400);
  assert.notEqual(orders.find((o) => o.id === "order-alice-online").payment_status, "Paid");
});

test("refunds: customers cannot trigger or retry a refund", async () => {
  for (const token of [tokens.alice(), tokens.bob()]) {
    const res = await call("PATCH", "/api/orders/admin/order-alice-online/retry-refund", { token, body: {} });
    assert.equal(res.status, 403);
  }
  assert.equal((await call("PATCH", "/api/orders/admin/order-alice-online/retry-refund", { body: {} })).status, 401);
  assert.equal(razorpayCalls.length, 0);
});

test("refunds: an admin retry never creates a duplicate refund", async () => {
  // Already refunded: refused before Razorpay is even consulted.
  const done = await call("PATCH", "/api/orders/admin/order-refunded/retry-refund", { token: tokens.admin(), body: {} });
  assert.equal(done.status, 409);
  assert.match(done.body.message, /already complete/i);

  // Not cancelled at all: nothing to refund.
  const live = await call("PATCH", "/api/orders/admin/order-alice-cod/retry-refund", { token: tokens.admin(), body: {} });
  assert.equal(live.status, 409);

  // Unknown order.
  const missing = await call("PATCH", "/api/orders/admin/nope/retry-refund", { token: tokens.superadmin(), body: {} });
  assert.equal(missing.status, 404);

  assert.equal(razorpayCalls.length, 0);
});

test("an admin status change cannot overwrite a cancel that landed in between", async () => {
  const ok = await call("PATCH", "/api/orders/admin/order-bob/status", { token: tokens.admin(), body: { status: "Packed" } });
  assert.equal(ok.status, 200);
  assert.equal(orders.find((o) => o.id === "order-bob").status, "Packed");

  beforeStatusUpdate = () => {
    orders.find((o) => o.id === "order-alice-cod").status = "Cancelled";
  };
  const raced = await call("PATCH", "/api/orders/admin/order-alice-cod/status", { token: tokens.admin(), body: { status: "Shipped" } });
  assert.equal(raced.status, 409);
  assert.equal(orders.find((o) => o.id === "order-alice-cod").status, "Cancelled");
});

test("a cancelled order cannot be moved to another status by an admin", async () => {
  const res = await call("PATCH", "/api/orders/admin/order-refunded/status", { token: tokens.admin(), body: { status: "Shipped" } });
  assert.ok(res.status >= 400);
  assert.equal(orders.find((o) => o.id === "order-refunded").status, "Cancelled");
});

test("subscriptions cannot be activated by customers (no free memberships)", async () => {
  const own = await call("PATCH", "/api/subscriptions/sub-alice/activate", { token: tokens.alice(), body: { paymentId: "fake" } });
  assert.equal(own.status, 403);
  const other = await call("PATCH", "/api/subscriptions/sub-alice/activate", { token: tokens.bob(), body: { paymentId: "fake" } });
  assert.equal(other.status, 403);
  assert.equal(subscriptions[0].status, "pending");
});

// ======================================================== validation & errors ==
test("auth endpoints reject non-string input (operator / type confusion)", async () => {
  const cases = [
    ["/api/auth", { email: { $ne: "" }, password: "password123" }],
    ["/api/auth", { email: "a@b.co", password: { $ne: "" } }],
    ["/api/auth", { email: "not-an-email", password: "password123" }],
    ["/api/auth/verify-otp", { email: { $gt: "" }, otp: "123456", purpose: "login" }],
    ["/api/auth/verify-otp", { email: "a@b.co", otp: ["123456"], purpose: "login" }],
    ["/api/auth/forgot-password", { email: ["a@b.co"] }],
    ["/api/auth/reset-password", { resetToken: { a: 1 }, newPassword: "password123" }],
    ["/api/auth/resend-otp", { email: { x: 1 }, purpose: "login" }],
    ["/api/auth/google", { credential: { x: 1 } }],
  ];
  for (const [url, body] of cases) {
    const res = await call("POST", url, { body });
    assert.equal(res.status, 400, `${url} ${JSON.stringify(body)} -> ${res.status}`);
  }
});

test("checkout rejects malformed shipping addresses before touching the database", async () => {
  const good = { name: "A", phone: "9876543210", pincode: "400001", address: "1 Road", city: "Mumbai", state: "MH" };
  const bad = [
    { ...good, pincode: "ABCDEF" },
    { ...good, phone: "<script>" },
    { ...good, name: { $ne: "" } },
    { ...good, address: "x".repeat(600) },
    ["not", "an", "object"],
  ];
  for (const shippingAddress of bad) {
    const res = await call("POST", "/api/orders", { token: tokens.alice(), body: { paymentMethod: "cod", shippingAddress } });
    assert.equal(res.status, 400);
  }
  assert.equal(queries.some((q) => q.text.includes("insert into orders")), false);
});

test("admin product input: negative / non-numeric prices are rejected", async () => {
  for (const price of [-5, "abc", 1e12]) {
    const res = await call("POST", "/api/products", {
      token: tokens.admin(),
      body: { id: "p-x", slug: "p-x", name: "X", price },
    });
    assert.equal(res.status, 400, `price ${price}`);
    assert.match(res.body.message, /price/i);
  }
});

test("uploads: non-image content and spoofed types are rejected", async () => {
  const send = async (filename, type, bytes) => {
    const form = new FormData();
    form.append("id", "p-x");
    form.append("slug", "p-x");
    form.append("name", "X");
    form.append("price", "100");
    form.append("images", new Blob([bytes], { type }), filename);
    const response = await fetch(`${base}/api/products`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.admin()}` },
      body: form,
    });
    return response.status;
  };

  // An HTML file pretending to be a PNG by its declared type.
  assert.equal(await send("evil.html", "image/png", "<script>alert(1)</script>"), 400);
  // Right name and type, but the bytes are not an image.
  assert.equal(await send("photo.png", "image/png", "<script>alert(1)</script>"), 400);
  // Customers cannot upload at all.
  const form = new FormData();
  form.append("images", new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])], { type: "image/jpeg" }), "a.jpg");
  const asCustomer = await fetch(`${base}/api/products`, { method: "POST", headers: { Authorization: `Bearer ${tokens.alice()}` }, body: form });
  assert.equal(asCustomer.status, 403);
});

test("database / driver errors never reach the client", async () => {
  failOrderQueries = true;
  const res = await call("GET", "/api/orders/my", { token: tokens.alice() });
  assert.ok(res.status >= 400);
  const text = JSON.stringify(res.body);
  assert.doesNotMatch(text, /ER_PARSE_ERROR|SQL|ardenby|secret detail|orders/i);
});

test("malformed JSON gets a clean 400 and unknown API paths a JSON 404", async () => {
  const bad = await call("POST", "/api/auth", { raw: "{not json", headers: { "Content-Type": "application/json" } });
  assert.equal(bad.status, 400);

  const missing = await call("GET", "/api/definitely-not-a-route");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.success, false);
});

test("product listing page size is capped", async () => {
  await call("GET", "/api/products?limit=1000000&page=-4");
  assert.ok(lastProductParams, "product query should have run");
  const [limit, offset] = lastProductParams.slice(-2);
  assert.ok(limit <= 100, `limit was ${limit}`);
  assert.ok(offset >= 0, `offset was ${offset}`);
});

// ================================================================ hardening ==
test("security headers are set and the API is not cacheable", async () => {
  const res = await call("GET", "/api/users/me", { token: tokens.alice() });
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-powered-by"), null);
});

test("OTP / login endpoints are rate limited per account", async () => {
  let last;
  for (let i = 0; i < 12; i += 1) {
    last = await call("POST", "/api/auth/forgot-password", { body: { email: "flood@example.com" } });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  assert.ok(last.headers.get("retry-after"));

  // A different address is unaffected.
  const other = await call("POST", "/api/auth/forgot-password", { body: { email: "someone-else@example.com" } });
  assert.equal(other.status, 200);
});

test("no test above reached Razorpay", () => {
  assert.deepEqual(razorpayCalls, []);
});
