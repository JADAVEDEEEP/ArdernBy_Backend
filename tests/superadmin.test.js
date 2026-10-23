// Super Admin API tests. Drive the REAL app (router, auth + role middleware,
// controller, service) over HTTP with an in-memory stand-in for MySQL.
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

const ids = { customer: uuid(1), admin: uuid(2), owner: uuid(3), second: uuid(4) };

const accounts = [];
const queries = [];

const reset = () => {
  accounts.length = 0;
  accounts.push(
    { id: ids.customer, email: "c@example.com", role: "customer", is_active: 1, full_name: "Cust" },
    { id: ids.admin, email: "a@example.com", role: "admin", is_active: 1, full_name: "Adm" },
    { id: ids.owner, email: "o@example.com", role: "superadmin", is_active: 1, full_name: "Owner" }
  );
};
reset();

const row = (a) => ({ ...a, phone: null, auth_provider: "email", email_verified: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });

const execute = async (sql, params = []) => {
  const text = norm(sql);
  queries.push(text);

  if (text.startsWith("select id, email, role, is_active from profiles where id = ? limit 1")) {
    return [accounts.filter((a) => a.id === params[0])];
  }
  if (text.includes("role = 'superadmin' and is_active = 1 for update")) {
    return [accounts.filter((a) => a.role === "superadmin" && a.is_active)];
  }
  if (text.includes("from profiles where id = ? and email not like") && text.endsWith("for update")) {
    return [accounts.filter((a) => a.id === params[0])];
  }
  if (text.startsWith("update profiles set is_active = ?")) {
    const a = accounts.find((x) => x.id === params[1]);
    a.is_active = params[0];
    return [{ affectedRows: 1 }];
  }
  if (text.startsWith("update profiles set role = ?")) {
    const a = accounts.find((x) => x.id === params[1]);
    a.role = params[0];
    return [{ affectedRows: 1 }];
  }
  if (text.includes("from profiles where id = ? limit 1")) {
    return [accounts.filter((a) => a.id === params[0]).map(row)];
  }
  if (text.startsWith("select count(*) as total from profiles")) return [[{ total: accounts.length }]];
  if (text.includes("sum(is_active = 0)")) {
    return [[{ total: accounts.length, customers: 1, admins: 1, superadmins: 1, inactive: 0 }]];
  }
  if (text.includes("limit") && text.includes("from profiles")) return [accounts.map(row)];

  // dashboard
  if (text.includes("sum(role = 'customer' and is_active = 1) as customers")) {
    return [[{ customers: 1, admins: 1, superadmins: 1 }]];
  }
  if (text.includes("as out_of_stock")) return [[{ products: 4, out_of_stock: 0, low_stock: 1, units: 20 }]];
  if (text.startsWith("select count(*) as orders from orders")) return [[{ orders: 3 }]];
  if (text.includes("as total_revenue")) return [[{ today: "2026-10-23", total_revenue: "2500.50", paid_orders: 2 }]];
  if (text.includes("group by day")) return [[{ day: "2026-10-23", orders: 2, revenue: "2500.50" }]];
  if (text.includes("from orders o left join profiles")) {
    return [[{ id: "o1", order_number: "ARD-1", customer: "Cust", total_amount: "100.00", payment_status: "Paid", status: "Shipped", created_at: "2026-10-23T00:00:00Z" }]];
  }
  if (text.includes("from order_items")) return [[]];
  if (text.includes("group by")) return [[{ status: "Paid", count: 1 }]];
  if (text.includes("as new_7d")) return [[{ new_7d: 1, new_30d: 1, deactivated: 0, verified: 1, with_orders: 1 }]];
  throw new Error(`superadmin.test fake DB: unhandled SQL: ${text}`);
};

const pool = {
  execute,
  async getConnection() {
    return { execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
  },
};

const sqlPath = require.resolve(path.join(root, "config", "sql.js"));
require.cache[sqlPath] = {
  id: sqlPath,
  filename: sqlPath,
  loaded: true,
  exports: { poolPromise: Promise.resolve(pool), testDatabaseConnection: async () => {} },
};

const app = require(path.join(root, "app.js"));
let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(reset);

const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });

const call = async (method, url, { as, body } = {}) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(as ? { Authorization: `Bearer ${token(as)}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const endpoints = [
  ["GET", "/api/superadmin/dashboard"],
  ["GET", "/api/superadmin/users"],
  ["PATCH", `/api/superadmin/users/${ids.customer}/status`, { isActive: false }],
  ["PATCH", `/api/superadmin/users/${ids.customer}/role`, { role: "admin" }],
];

test("every super admin endpoint rejects anonymous callers", async () => {
  for (const [method, url, body] of endpoints) {
    assert.equal((await call(method, url, { body })).status, 401, url);
  }
});

test("customers and common admins are denied on every endpoint", async () => {
  for (const as of [ids.customer, ids.admin]) {
    for (const [method, url, body] of endpoints) {
      assert.equal((await call(method, url, { as, body })).status, 403, `${as} ${url}`);
    }
  }
  assert.equal(accounts.find((a) => a.id === ids.customer).role, "customer");
});

test("dashboard returns aggregated real figures", async () => {
  const { status, json } = await call("GET", "/api/superadmin/dashboard?days=7", { as: ids.owner });
  assert.equal(status, 200);
  assert.equal(json.data.stats.totalRevenue, 2500.5);
  assert.equal(json.data.stats.totalOrders, 3);
  assert.equal(json.data.stats.totalCommonAdmins, 1);
  assert.equal(json.data.series.length, 7);
  assert.equal(json.data.series.at(-1).revenue, 2500.5);
  assert.equal(json.data.recentOrders[0].orderNumber, "ARD-1");
});

test("revenue SQL counts only paid, non-cancelled orders", async () => {
  queries.length = 0;
  await call("GET", "/api/superadmin/dashboard", { as: ids.owner });
  const revenueSql = queries.find((q) => q.includes("as total_revenue"));
  assert.match(revenueSql, /lower\(o\.payment_status\) = 'paid'/);
  assert.match(revenueSql, /not in \('cancelled', 'cancellation requested'\)/);
});

test("user list never selects password hashes or tokens", async () => {
  queries.length = 0;
  const { status, json } = await call("GET", "/api/superadmin/users?search=a%25_&role=admin", { as: ids.owner });
  assert.equal(status, 200);
  assert.equal(json.users.length, 3);
  assert.ok(queries.every((q) => !q.includes("password_hash") && !q.includes("google_id")));
  assert.ok(!JSON.stringify(json).includes("password"));
});

test("status and role changes work for other accounts", async () => {
  let r = await call("PATCH", `/api/superadmin/users/${ids.customer}/status`, { as: ids.owner, body: { isActive: false } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.isActive, false);

  await call("PATCH", `/api/superadmin/users/${ids.customer}/status`, { as: ids.owner, body: { isActive: true } });
  r = await call("PATCH", `/api/superadmin/users/${ids.customer}/role`, { as: ids.owner, body: { role: "admin" } });
  assert.equal(r.status, 200);
  assert.equal(accounts.find((a) => a.id === ids.customer).role, "admin");
});

test("a super admin cannot change their own account", async () => {
  const r = await call("PATCH", `/api/superadmin/users/${ids.owner}/role`, { as: ids.owner, body: { role: "customer" } });
  assert.equal(r.status, 403);
  assert.equal(accounts.find((a) => a.id === ids.owner).role, "superadmin");
});

test("demoting another super admin is allowed while the caller remains", async () => {
  accounts.push({ id: ids.second, email: "s@example.com", role: "superadmin", is_active: 1, full_name: "Second" });
  const ok = await call("PATCH", `/api/superadmin/users/${ids.second}/role`, { as: ids.owner, body: { role: "customer" } });
  assert.equal(ok.status, 200);
});

// Over HTTP the caller is always a second active super admin, so this guard is
// defence in depth (e.g. the caller is deactivated mid-request). Test it directly.
test("service refuses to demote or deactivate the last active super admin", async () => {
  const service = require(path.join(root, "services", "superadmin.service.js"));
  await assert.rejects(
    service.setUserRole({ actorId: ids.customer, targetId: ids.owner, role: "admin" }),
    (e) => e.statusCode === 409 && /last active super admin/i.test(e.message)
  );
  await assert.rejects(
    service.setUserStatus({ actorId: ids.customer, targetId: ids.owner, isActive: false }),
    (e) => e.statusCode === 409
  );
  assert.equal(accounts.find((a) => a.id === ids.owner).role, "superadmin");
  assert.equal(accounts.find((a) => a.id === ids.owner).is_active, 1);
});

test("input validation", async () => {
  assert.equal((await call("PATCH", "/api/superadmin/users/not-a-uuid/status", { as: ids.owner, body: { isActive: false } })).status, 400);
  assert.equal((await call("PATCH", `/api/superadmin/users/${ids.customer}/status`, { as: ids.owner, body: { isActive: "no" } })).status, 400);
  assert.equal((await call("PATCH", `/api/superadmin/users/${ids.customer}/role`, { as: ids.owner, body: { role: "root" } })).status, 400);
  assert.equal((await call("PATCH", `/api/superadmin/users/${uuid(99)}/role`, { as: ids.owner, body: { role: "admin" } })).status, 404);
});
