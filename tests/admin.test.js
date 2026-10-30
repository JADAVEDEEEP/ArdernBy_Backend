// Admin analytics + settings API tests. Drive the REAL app over HTTP with an
// in-memory stand-in for MySQL.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "test-secret-not-used-anywhere-else";
process.env.RAZORPAY_KEY_ID = "rzp_test_unit";
process.env.RAZORPAY_KEY_SECRET = "unit_secret";
delete process.env.CORS_ORIGINS;

const root = path.join(__dirname, "..");
const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = { customer: uuid(1), admin: uuid(2), owner: uuid(3) };

const accounts = [
  { id: ids.customer, email: "c@example.com", role: "customer", is_active: 1 },
  { id: ids.admin, email: "a@example.com", role: "admin", is_active: 1 },
  { id: ids.owner, email: "o@example.com", role: "superadmin", is_active: 1 },
];
const settingsRows = new Map();

const run = async (sql, params = []) => {
  const text = norm(sql);
  // The item-level tables are not installed here: reports use the payment-status rule only.
  if (/from order_cancellations limit 1/.test(text)) { const e = new Error("no such table"); e.code = "ER_NO_SUCH_TABLE"; throw e; }

  // Admin / Super Admin sessions are checked against revocations (none in these tests).
  if (text.startsWith("select revoked_before from session_revocations")) return [[]];
  if (text.startsWith("select id, email, role, is_active from profiles")) {
    return [accounts.filter((a) => a.id === params[0])];
  }
  if (text.startsWith("create table if not exists store_settings")) return [{}];
  if (text.startsWith("select section, value, updated_at from store_settings")) {
    return [[...settingsRows].map(([section, value]) => ({ section, value, updated_at: null }))];
  }
  if (text.startsWith("select value from store_settings where section")) {
    const section = params.length ? params[0] : "notifications";
    return [settingsRows.has(section) ? [{ value: settingsRows.get(section) }] : []];
  }
  if (text.startsWith("insert into store_settings")) {
    settingsRows.set(params[0], params[1]);
    return [{ affectedRows: 1 }];
  }
  if (text.includes("as new_orders")) {
    return [[{ new_orders: 2, failed_payments: 0, cancellations: 1 }]];
  }
  if (text.includes("as low_stock")) return [[{ low_stock: 3, out_of_stock: 1 }]];

  // analytics
  if (text.includes("as paid_orders")) {
    return [[{ orders: 4, revenue: "1500.00", paid_orders: 3, delivered: 2, cancelled: 1, refunded_amount: "0", discounts: "100" }]];
  }
  if (text.includes("select coalesce(sum(oi.quantity)")) return [[{ units: 5 }]];
  if (text.includes("group by bucket")) return [[{ bucket: "2026-10-02", orders: 2, revenue: "900" }]];
  if (text.includes("from orders o") || text.includes("from order_items oi")) return [[]];
  throw new Error(`admin.test fake DB: unhandled SQL: ${text}`);
};

const pool = { execute: run, query: run };
const sqlPath = require.resolve(path.join(root, "config", "sql.js"));
require.cache[sqlPath] = {
  id: sqlPath,
  filename: sqlPath,
  loaded: true,
  exports: { poolPromise: Promise.resolve(pool), testDatabaseConnection: async () => {} },
};

const app = require(path.join(root, "app.js"));
const analytics = require(path.join(root, "services", "analytics.service.js"));
let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => settingsRows.clear());

const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
const call = async (method, url, { as, body } = {}) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...(as ? { Authorization: `Bearer ${token(as)}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const endpoints = [
  ["GET", "/api/admin/analytics"],
  ["GET", "/api/admin/settings"],
  ["PUT", "/api/admin/settings/store", { storeName: "X" }],
  ["GET", "/api/admin/alerts"],
];

test("admin endpoints reject anonymous callers and customers", async () => {
  for (const [method, url, body] of endpoints) {
    assert.equal((await call(method, url, { body })).status, 401, `${url} anonymous`);
    assert.equal((await call(method, url, { as: ids.customer, body })).status, 403, `${url} customer`);
  }
});

test("range validation rejects bad, reversed, future and oversized ranges", () => {
  assert.throws(() => analytics.resolveRange({ from: "nope" }), /YYYY-MM-DD/);
  assert.throws(() => analytics.resolveRange({ from: "2026-02-31", to: "2026-03-01" }), /not a valid date/);
  assert.throws(() => analytics.resolveRange({ from: "2026-03-05", to: "2026-03-01" }), /after/);
  assert.throws(() => analytics.resolveRange({ from: "2020-01-01", to: "2026-01-01" }), /exceed/);
  assert.throws(() => analytics.resolveRange({ from: "2999-01-01", to: "2999-01-02" }), /future/);
});

test("range picks granularity and a same-length previous period", () => {
  const r = analytics.resolveRange({ from: "2026-03-01", to: "2026-03-10", compare: "1" });
  assert.equal(r.granularity, "day");
  assert.equal(r.current.days, 10);
  assert.equal(r.previous.from, "2026-02-19");
  assert.equal(r.previous.to, "2026-02-28");
  // IST midnight is 18:30 UTC the day before.
  assert.equal(r.current.start.toISOString(), "2026-02-28T18:30:00.000Z");
  assert.equal(analytics.resolveRange({ from: "2026-01-01", to: "2026-03-01" }).granularity, "week");
  assert.equal(analytics.resolveRange({ from: "2025-06-01", to: "2026-03-01" }).granularity, "month");
});

test("percentage change is null when there is no baseline", () => {
  assert.equal(analytics.change(10, 0), null);
  assert.equal(analytics.change(150, 100), 50);
});

test("bucket keys fill gaps for day, week and month", () => {
  assert.deepEqual(analytics.bucketKeys({ from: "2026-03-02", to: "2026-03-05" }, "day"), [
    "2026-03-02",
    "2026-03-03",
    "2026-03-04",
    "2026-03-05",
  ]);
  assert.deepEqual(analytics.bucketKeys({ from: "2026-03-04", to: "2026-03-16" }, "week"), [
    "2026-03-02",
    "2026-03-09",
    "2026-03-16",
  ]);
  assert.deepEqual(analytics.bucketKeys({ from: "2026-01-15", to: "2026-03-01" }, "month"), [
    "2026-01-01",
    "2026-02-01",
    "2026-03-01",
  ]);
});

test("analytics returns aggregated numbers and compares to the previous period", async () => {
  const { status, json } = await call("GET", "/api/admin/analytics?from=2026-10-01&to=2026-10-03&compare=1", { as: ids.admin });
  assert.equal(status, 200);
  assert.equal(json.data.summary.revenue, 1500);
  assert.equal(json.data.summary.averageOrderValue, 500);
  assert.equal(json.data.summary.cancellationRate, 25);
  assert.equal(json.data.series.length, 3);
  assert.equal(json.data.series[1].revenue, 900);
  assert.equal(json.data.comparison.revenue, 0);
  assert.ok(json.data.previousRange);
});

test("analytics rejects invalid query parameters with 400", async () => {
  const { status } = await call("GET", "/api/admin/analytics?from=2026-10-09&to=2026-10-01", { as: ids.admin });
  assert.equal(status, 400);
});

test("settings: defaults load, saves persist, other sections are untouched", async () => {
  let res = await call("GET", "/api/admin/settings", { as: ids.admin });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.settings.store.storeName, "KOVENIK");
  assert.equal(res.json.data.config.currency, "INR");

  res = await call("PUT", "/api/admin/settings/store", {
    as: ids.admin,
    body: { storeName: "Kovenik Co", contactEmail: "hi@kovenik.in" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.settings.contactEmail, "hi@kovenik.in");

  res = await call("PUT", "/api/admin/settings/notifications", { as: ids.admin, body: { lowStock: false } });
  assert.equal(res.status, 200);

  res = await call("GET", "/api/admin/settings", { as: ids.admin });
  assert.equal(res.json.data.settings.store.storeName, "Kovenik Co");
  assert.equal(res.json.data.settings.notifications.lowStock, false);
  assert.equal(res.json.data.settings.notifications.newOrders, true);
  assert.equal(res.json.data.settings.brand.displayName, "KOVENIK");
});

test("settings validation rejects bad values, unknown fields and sections", async () => {
  const put = (section, body) => call("PUT", `/api/admin/settings/${section}`, { as: ids.admin, body });
  assert.equal((await put("store", { contactEmail: "not-an-email" })).status, 400);
  assert.equal((await put("store", { storeName: "" })).status, 400);
  assert.equal((await put("store", { currency: "USD" })).status, 400);
  assert.equal((await put("notifications", { lowStock: "yes" })).status, 400);
  assert.equal((await put("notifications", { lowStockThreshold: 0 })).status, 400);
  assert.equal((await put("secrets", { a: 1 })).status, 404);
  assert.equal(settingsRows.size, 0);
});

test("settings responses never contain environment secrets", async () => {
  const res = await call("GET", "/api/admin/settings", { as: ids.admin });
  const body = JSON.stringify(res.json);
  assert.ok(!body.includes(process.env.JWT_SECRET));
  assert.ok(!body.includes("unit_secret"));
});

test("alerts honour notification preferences", async () => {
  await call("PUT", "/api/admin/settings/notifications", { as: ids.admin, body: { lowStock: false } });
  const { status, json } = await call("GET", "/api/admin/alerts", { as: ids.admin });
  assert.equal(status, 200);
  const types = json.alerts.map((a) => a.type);
  assert.ok(types.includes("new-orders"));
  assert.ok(types.includes("cancellations"));
  assert.ok(!types.includes("low-stock"));
});
