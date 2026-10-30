// Admin controls: review moderation, returns, inventory history, audit trail,
// CSV export, financial report, session revocation, role-change confirmation
// and admin invitations. Drives the REAL app (routers, auth, services) over HTTP
// with an in-memory stand-in for MySQL and a stubbed mailer / refund call.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "test-secret-not-used-anywhere-else";
process.env.RAZORPAY_KEY_ID = "rzp_test_unit";
process.env.RAZORPAY_KEY_SECRET = "unit_secret";
process.env.BREVO_FROM_EMAIL = "noreply@example.com";
delete process.env.CORS_ORIGINS;

const root = path.join(__dirname, "..");
const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = {
  customer: uuid(1),
  admin: uuid(2),
  owner: uuid(3),
  second: uuid(4),
  buyer: uuid(5),
};

// ---------------------------------------------------------------- state
const db = {};
const mails = [];
let mailShouldFail = false;
let failMailTo = null;
let confirmationsLive = true;
let canned = {};

const reset = () => {
  db.accounts = [
    { id: ids.customer, email: "c@example.com", role: "customer", is_active: 1, full_name: "Cust" },
    { id: ids.admin, email: "a@example.com", role: "admin", is_active: 1, full_name: "Adm" },
    { id: ids.owner, email: "o@example.com", role: "superadmin", is_active: 1, full_name: "Owner" },
    { id: ids.second, email: "s@example.com", role: "superadmin", is_active: 1, full_name: "Second" },
    { id: ids.buyer, email: "b@example.com", role: "customer", is_active: 1, full_name: "Buyer" },
  ];
  db.audit = [];
  db.movements = [];
  db.moderation = [];
  db.reviews = [
    { id: "rv_1", product_id: "p1", author_name: "Buyer", rating: 5, title: "Great fit", comment: "Really nice fabric", verified: 1, created_at: "2026-10-01T00:00:00.000Z" },
    { id: "rv_2", product_id: "p1", author_name: "Other", rating: 1, title: "Awful", comment: "Abusive text here", verified: 1, created_at: "2026-10-02T00:00:00.000Z" },
  ];
  db.products = [{ id: "p1", slug: "tee", name: "Tee" }];
  db.variants = [
    { id: "v1", product_id: "p1", inventory: 5, size: "M", color: "Black" },
    { id: "v2", product_id: "p1", inventory: 8, size: "L", color: "Black" },
  ];
  db.orders = [];
  db.items = [];
  db.returns = [];
  db.returnItems = [];
  db.settings = new Map();
  db.confirmations = [];
  db.revocations = new Map();
  db.logins = [];
  mails.length = 0;
  mailShouldFail = false;
  failMailTo = null;
  confirmationsLive = true;
  canned = {};
};
reset();

// Every line of an order, whole quantity (what "return everything" sends).
const allItems = (orderId) => [
  { orderItemId: orderId + "-a", quantity: 2 },
  { orderItemId: orderId + "-b", quantity: 1 },
];

const addOrder = (extra = {}) => {
  const order = {
    id: "o1",
    user_id: ids.buyer,
    order_number: "KV-1",
    status: "Delivered",
    payment_method: "online",
    payment_status: "Paid",
    payment_id: "pay_1",
    total_amount: 1000,
    subtotal: 1000,
    discount_amount: 0,
    tax_amount: 0,
    age_seconds: 3600,
    ...extra,
  };
  db.orders.push(order);
  db.items.push(
    { id: order.id + "-a", order_id: order.id, product_id: "p1", variant_id: "v1", quantity: 2, product_name: "Tee", product_image: null, size: "M", color: "Black", unit_price: 300 },
    { id: order.id + "-b", order_id: order.id, product_id: "p1", variant_id: "v2", quantity: 1, product_name: "Tee", product_image: null, size: "L", color: "Black", unit_price: 400 }
  );
  return order;
};

// ---------------------------------------------------------------- fake SQL
const run = async (sql, p = []) => {
  const t = norm(sql);
  // The item-level tables are not installed here: reports use the payment-status rule only.
  if (/from order_cancellations limit 1/.test(t)) { const e = new Error("no such table"); e.code = "ER_NO_SUCH_TABLE"; throw e; }

  // --- sessions / auth
  if (t.startsWith("select revoked_before from session_revocations")) {
    return [db.revocations.has(p[0]) ? [{ revoked_before: db.revocations.get(p[0]) }] : []];
  }
  if (t.startsWith("insert into session_revocations")) {
    db.revocations.set(p[0], p[1]);
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("insert into login_history")) {
    db.logins.push({ id: p[0], user_id: p[1], method: p[2], ip: p[3], user_agent: p[4], created_at: "2026-10-29T10:00:00.000Z" });
    return [{ affectedRows: 1 }];
  }
  if (t.includes("from login_history")) {
    return [db.logins.filter((l) => l.user_id === p[0]).map((l) => ({ ...l }))];
  }
  if (t.startsWith("select id, email, role, is_active from profiles where id = ? limit 1")) {
    return [db.accounts.filter((a) => a.id === p[0])];
  }

  // --- superadmin service
  if (t.includes("role = 'superadmin' and is_active = 1 for update")) {
    return [db.accounts.filter((a) => a.role === "superadmin" && a.is_active)];
  }
  if (t.includes("from profiles where id = ? and email not like") && t.endsWith("for update")) {
    return [db.accounts.filter((a) => a.id === p[0])];
  }
  if (t.includes("from profiles where id = ? and email not like")) {
    // A real database hands back a copy, not the live row.
    return [db.accounts.filter((a) => a.id === p[0]).map((a) => ({ ...a }))];
  }
  if (t.startsWith("select count(*) as total from profiles where role = 'superadmin'")) {
    return [[{ total: db.accounts.filter((a) => a.role === "superadmin" && a.is_active).length }]];
  }
  if (t.startsWith("update profiles set role = ?")) {
    db.accounts.find((a) => a.id === p[1]).role = p[0];
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("update profiles set is_active = ?")) {
    db.accounts.find((a) => a.id === p[1]).is_active = p[0];
    return [{ affectedRows: 1 }];
  }
  if (t.includes("from profiles where id = ? limit 1")) {
    return [db.accounts.filter((a) => a.id === p[0]).map((a) => ({ ...a, phone: null, auth_provider: "email", email_verified: 1, created_at: "x", updated_at: "x" }))];
  }
  if (t.startsWith("select email from profiles where role = 'superadmin'")) {
    return [db.accounts.filter((a) => a.role === "superadmin" && a.is_active).map((a) => ({ email: a.email }))];
  }
  if (t.startsWith("select id from profiles where email = ?")) {
    return [db.accounts.filter((a) => a.email === p[0])];
  }
  if (t.startsWith("insert into profiles")) {
    db.accounts.push({ id: p[0], full_name: p[1], email: p[2], password_hash: p[3], role: "admin", is_active: 1 });
    return [{ affectedRows: 1 }];
  }
  if (t.includes("from profiles where id in")) {
    return [db.accounts.filter((a) => p.includes(a.id)).map((a) => ({ id: a.id, full_name: a.full_name, email: a.email }))];
  }

  // --- confirmations
  if (t.startsWith("select count(*) as total from admin_confirmations")) {
    return [[{ total: db.confirmations.filter((c) => c.actor_id === p[0]).length }]];
  }
  if (t.startsWith("insert into admin_confirmations")) {
    db.confirmations.push({
      id: p[0], action: p[1], actor_id: p[2], target_id: p[3], target_email: p[4], new_role: p[5],
      reason: p[6], code_hash: p[7], attempts: 0, used_at: null, live: 1,
    });
    return [{ affectedRows: 1 }];
  }
  if (t.includes("from admin_confirmations where id = ?")) {
    return [db.confirmations.filter((c) => c.id === p[0]).map((c) => ({ ...c, live: confirmationsLive ? 1 : 0 }))];
  }
  if (t.startsWith("update admin_confirmations set attempts = attempts + 1")) {
    db.confirmations.find((c) => c.id === p[0]).attempts += 1;
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("update admin_confirmations set used_at")) {
    const c = db.confirmations.find((x) => x.id === p[0]);
    if (!c || c.used_at || !confirmationsLive || c.attempts >= p[1]) return [{ affectedRows: 0 }];
    c.used_at = "now";
    return [{ affectedRows: 1 }];
  }

  // --- audit
  if (t.startsWith("insert ignore into audit_logs")) {
    const key = p[12];
    if (key && db.audit.some((a) => a.dedupe_key === key)) return [{ affectedRows: 0 }];
    db.audit.push({
      id: p[0], actor_id: p[1], actor_email: p[2], actor_role: p[3], action: p[4], resource_type: p[5],
      resource_id: p[6], outcome: p[7], reason: p[8], before_value: p[9], after_value: p[10], ip: p[11],
      dedupe_key: key, created_at: "2026-10-29T10:00:00.000Z",
    });
    return [{ affectedRows: 1 }];
  }
  if (t.includes("from audit_logs")) {
    let rows = db.audit;
    if (t.includes("action = ?")) rows = rows.filter((a) => a.action === p[0]);
    if (t.startsWith("select count(*)")) return [[{ total: rows.length }]];
    return [rows.map((a) => ({ ...a }))];
  }

  // --- inventory
  if (t.startsWith("select product_id, inventory from product_variants where id = ?")) {
    return [db.variants.filter((v) => v.id === p[0])];
  }
  if (t.startsWith("update product_variants set inventory = inventory + ?")) {
    db.variants.find((v) => v.id === p[1]).inventory += p[0];
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("insert ignore into inventory_movements")) {
    const key = p[11];
    if (key && db.movements.some((m) => m.dedupe_key === key)) return [{ affectedRows: 0 }];
    db.movements.push({
      id: p[0], product_id: p[1], variant_id: p[2], previous_qty: p[3], new_qty: p[4], delta: p[5],
      reason: p[6], source: p[7], reference_type: p[8], reference_id: p[9], actor_id: p[10], dedupe_key: key,
      created_at: "2026-10-29T10:00:00.000Z",
    });
    return [{ affectedRows: 1 }];
  }
  if (t.includes("from inventory_movements")) {
    if (t.startsWith("select count(*)")) return [[{ total: db.movements.length }]];
    return [db.movements.map((m) => ({ ...m }))];
  }
  if (t.startsWith("select id, name from products where id in")) {
    return [db.products.filter((x) => p.includes(x.id))];
  }
  if (t.startsWith("select id, size, color from product_variants where id in")) {
    return [db.variants.filter((v) => p.includes(v.id))];
  }

  // --- reviews
  if (t.startsWith("select id, slug, name from products where slug = ?")) {
    return [db.products.filter((x) => x.slug === p[0])];
  }
  if (t.startsWith("select review_id from review_moderation where product_id = ?")) {
    return [db.moderation.filter((m) => m.product_id === p[0] && m.status === "hidden").map((m) => ({ review_id: m.review_id }))];
  }
  if (t.startsWith("select review_id from review_moderation where status = 'hidden'")) {
    return [db.moderation.filter((m) => m.status === "hidden").map((m) => ({ review_id: m.review_id }))];
  }
  if (t.startsWith("select id, product_id, rating, title from product_reviews where id = ?")) {
    return [db.reviews.filter((r) => r.id === p[0])];
  }
  if (t.startsWith("select status from review_moderation where review_id = ?")) {
    return [db.moderation.filter((m) => m.review_id === p[0]).map((m) => ({ status: m.status }))];
  }
  if (t.startsWith("insert into review_moderation")) {
    const existing = db.moderation.find((m) => m.review_id === p[0]);
    if (existing) Object.assign(existing, { status: p[2], reason: p[3], moderated_by: p[4] });
    else db.moderation.push({ review_id: p[0], product_id: p[1], status: p[2], reason: p[3], moderated_by: p[4], moderated_at: "now" });
    return [{ affectedRows: 1 }];
  }
  if (t.includes("from review_moderation where review_id in")) {
    return [db.moderation.filter((m) => p.includes(m.review_id))];
  }
  if (t.startsWith("select round(rating) as stars")) {
    const excluded = p.slice(1);
    const rows = db.reviews.filter((r) => r.product_id === p[0] && !excluded.includes(r.id));
    const by = new Map();
    for (const r of rows) by.set(r.rating, { stars: r.rating, total: (by.get(r.rating)?.total || 0) + 1, sum_rating: (by.get(r.rating)?.sum_rating || 0) + r.rating });
    return [[...by.values()]];
  }
  if (t.startsWith("select id, author_name, rating, review_date, title, comment, verified, created_at from product_reviews where product_id = ?")) {
    const excluded = p.slice(1);
    return [db.reviews.filter((r) => r.product_id === p[0] && !excluded.includes(r.id)).map((r) => ({ ...r, review_date: "2026-10-01" }))];
  }
  if (t.startsWith("select count(*) as total from product_reviews r")) {
    return [[{ total: db.reviews.length }]];
  }
  if (t.includes("from product_reviews r inner join products p")) {
    return [db.reviews.map((r) => ({ ...r, product_name: "Tee", product_slug: "tee" }))];
  }
  if (t.includes("from product_review_photos") || t.includes("from orders o inner join order_items oi") || t.includes("from profiles p where concat")) {
    return [[]];
  }

  // --- settings
  if (t.startsWith("create table if not exists store_settings")) return [{}];
  if (t.startsWith("select value from store_settings where section = 'returns'")) {
    return [db.settings.has("returns") ? [{ value: db.settings.get("returns") }] : []];
  }
  if (t.startsWith("select value from store_settings where section = ?")) {
    return [db.settings.has(p[0]) ? [{ value: db.settings.get(p[0]) }] : []];
  }
  if (t.startsWith("select section, value, updated_at from store_settings")) {
    return [[...db.settings].map(([section, value]) => ({ section, value, updated_at: null }))];
  }
  if (t.startsWith("insert into store_settings")) {
    db.settings.set(p[0], p[1]);
    return [{ affectedRows: 1 }];
  }

  // --- returns / orders
  if (t.startsWith("select id, status, timestampdiff") || t.startsWith("select id, status, payment_status, timestampdiff")) {
    return [db.orders.filter((o) => o.id === p[0] && o.user_id === p[1])];
  }
  if (t.startsWith("select id, product_id, variant_id, product_name, product_image, size, color, quantity, unit_price from order_items where order_id = ?")) {
    return [db.items.filter((i) => i.order_id === p[0]).map((i) => ({ ...i }))];
  }
  if (t.startsWith("select order_id, id, product_id, variant_id") && t.includes("from order_items where order_id in")) {
    return [db.items.filter((i) => p.includes(i.order_id)).map((i) => ({ ...i }))];
  }
  if (t.startsWith("insert into return_request_items")) {
    db.returnItems.push({ id: p[0], return_id: p[1], order_item_id: p[2], product_id: p[3], variant_id: p[4], quantity: p[5] });
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("select order_item_id, quantity from return_request_items where return_id = ?")) {
    return [db.returnItems.filter((r) => r.return_id === p[0]).map((r) => ({ ...r }))];
  }
  if (t.startsWith("select return_id, order_item_id, quantity from return_request_items where return_id in")) {
    return [db.returnItems.filter((r) => p.includes(r.return_id)).map((r) => ({ ...r }))];
  }
  if (t.startsWith("select 1 from return_request_items")) return [[]];
  if (t.startsWith("select count(*) as total from return_requests")) return [[{ total: db.returns.length }]];
  if (t.startsWith("select *, date_format") && t.includes("order by created_at desc")) {
    return [db.returns.map((r) => ({ ...r }))];
  }
  if (t.startsWith("select id, status, customer_reason, decision_reason, refund_status")) {
    return [db.returns.filter((r) => r.order_id === p[0] && r.user_id === p[1]).map((r) => ({ ...r }))];
  }
  if (t.includes("from orders where id in")) {
    return [db.orders.filter((o) => p.includes(o.id)).map((o) => ({ ...o }))];
  }
  if (t.startsWith("select id, order_number, status, payment_method, payment_status, total_amount, subtotal")) {
    return [db.orders.filter((o) => o.id === p[0]).map((o) => ({ ...o }))];
  }
  if (t.startsWith("insert into return_requests")) {
    if (db.returns.some((r) => r.order_id === p[1])) {
      const error = new Error("dup");
      error.code = "ER_DUP_ENTRY";
      throw error;
    }
    db.returns.push({ id: p[0], order_id: p[1], user_id: p[2], status: "Requested", customer_reason: p[3], restocked_at: null, refund_status: null });
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("select * from return_requests where id = ?") || t.startsWith("select *, date_format")) {
    return [db.returns.filter((r) => r.id === p[0])];
  }
  if (t.startsWith("update return_requests set status = ?, decision_reason")) {
    const r = db.returns.find((x) => x.id === p[3] && x.status === "Requested");
    if (r) Object.assign(r, { status: p[0], decision_reason: p[1], decided_by: p[2] });
    return [{ affectedRows: r ? 1 : 0 }];
  }
  if (t.includes("from orders where id = ? limit 1 for update") || t.startsWith("select id, order_number, status, payment_method, payment_status, payment_id, total_amount from orders where id = ?")) {
    return [db.orders.filter((o) => o.id === p[0])];
  }
  if (t.startsWith("select variant_id, quantity from order_items")) {
    return [db.items.filter((i) => i.order_id === p[0])];
  }
  if (t.startsWith("update orders set status = 'returned'")) {
    db.orders.find((o) => o.id === p[0]).status = "Returned";
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("update return_requests set status = 'received'")) {
    const r = db.returns.find((x) => x.id === p[1] && x.status === "Approved");
    if (r) {
      r.status = "Received";
      r.received_by = p[0];
      if (t.includes("restocked_at = utc_timestamp")) r.restocked_at = "now";
    }
    return [{ affectedRows: r ? 1 : 0 }];
  }
  if (t.startsWith("update return_requests set refund_status = ?, refund_amount = ? where id = ?")) {
    Object.assign(db.returns.find((x) => x.id === p[2]), { refund_status: p[0], refund_amount: p[1] });
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("update return_requests set refund_status = ?, refund_id = ?")) {
    Object.assign(db.returns.find((x) => x.id === p[3]), { refund_status: p[0], refund_id: p[1], refund_amount: p[2] });
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("update orders set payment_status = ?, updated_at")) {
    db.orders.find((o) => o.id === p[1]).payment_status = p[0];
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("update return_requests set refund_status = 'manual_done'")) {
    db.returns.find((x) => x.id === p[0]).refund_status = "manual_done";
    return [{ affectedRows: 1 }];
  }

  // --- exports / reports
  if (t.startsWith("select count(*) as total from orders o")) return [[{ total: (canned.exportRows || []).length }]];
  if (t.includes("from orders o") && t.includes("order by o.created_at desc")) return [canned.exportRows || []];
  if (t.includes("from orders o") && t.includes("group by day")) return [canned.dayRows || []];
  if (t.includes("from orders o")) return [[canned.totals || {}]];

  throw new Error(`admin-controls.test fake DB: unhandled SQL: ${t}`);
};

const connection = {
  execute: run,
  query: run,
  beginTransaction: async () => {},
  commit: async () => {},
  rollback: async () => {},
  release() {},
};
const pool = { execute: run, query: run, getConnection: async () => connection };

const sqlPath = require.resolve(path.join(root, "config", "sql.js"));
require.cache[sqlPath] = {
  id: sqlPath,
  filename: sqlPath,
  loaded: true,
  exports: { poolPromise: Promise.resolve(pool), testDatabaseConnection: async () => {} },
};

const mailer = require(path.join(root, "config", "mailer.js"));
mailer.transporter.sendMail = async (message) => {
  if (mailShouldFail || (failMailTo && message.to === failMailTo)) throw new Error("smtp down");
  mails.push(message);
  return {};
};

const orderService = require(path.join(root, "services", "order.service.js"));
let refundCalls = 0;
let refundArgs = [];
let refundOutcome = { outcome: "refunded", refundId: "rfnd_1", refundStatus: "processed" };
orderService.initiateRefund = async (order) => {
  refundCalls += 1;
  refundArgs.push(order);
  return refundOutcome;
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
test.beforeEach(() => {
  reset();
  refundCalls = 0;
  refundArgs = [];
  refundOutcome = { outcome: "refunded", refundId: "rfnd_1", refundStatus: "processed" };
});

const token = (id, extra = {}) =>
  jwt.sign({ id, ...extra }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });

const call = async (method, url, { as, body, authToken, text = false } = {}) => {
  const bearer = authToken || (as ? token(as) : null);
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (text) {
    // Read bytes: response.text() would silently drop the UTF-8 byte-order mark.
    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, text: buffer.toString("utf8") };
  }
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const lastCode = () => /code is (\d{6})/.exec(mails.at(-1).text)[1];
const auditActions = () => db.audit.map((a) => a.action);

// Full two-step role change as `as`.
const changeRole = async (as, userId, role, reason = "Store needs another admin") => {
  const requested = await call("POST", `/api/superadmin/users/${userId}/role/request`, { as, body: { role, reason } });
  if (requested.status !== 200) return { requested };
  const code = lastCode();
  const confirmed = await call("PATCH", `/api/superadmin/users/${userId}/role`, {
    as,
    body: { role, reason, confirmationId: requested.json.confirmationId, code },
  });
  return { requested, confirmed, code };
};

// ======================================================= access control
const adminEndpoints = [
  ["GET", "/api/admin/reviews"],
  ["PATCH", "/api/admin/reviews/rv_1/moderation", { action: "hide", reason: "Abusive language" }],
  ["GET", "/api/admin/returns"],
  ["GET", `/api/admin/returns/${uuid(50)}`],
  ["PATCH", `/api/admin/returns/${uuid(50)}/decision`, { decision: "approve", reason: "Looks fine" }],
  ["GET", "/api/admin/inventory/movements"],
  ["GET", "/api/admin/exports/orders.csv"],
  ["GET", "/api/admin/security"],
];
const superEndpoints = [
  ["GET", "/api/superadmin/audit-logs"],
  ["GET", "/api/superadmin/reports/financial"],
  ["GET", "/api/superadmin/exports/sales-summary.csv"],
  ["GET", "/api/superadmin/exports/orders.csv"],
  ["POST", `/api/superadmin/users/${uuid(1)}/role/request`, { role: "admin", reason: "Because needed" }],
  ["POST", "/api/superadmin/admins/request", { email: "x@example.com", fullName: "X Y", reason: "New hire" }],
  ["POST", "/api/superadmin/admins", { email: "x@example.com", fullName: "X Y" }],
];

test("new admin endpoints reject anonymous callers and customers", async () => {
  for (const [method, url, body] of adminEndpoints) {
    assert.equal((await call(method, url, { body })).status, 401, `${url} anonymous`);
    assert.equal((await call(method, url, { as: ids.customer, body })).status, 403, `${url} customer`);
  }
});

test("super admin only endpoints refuse anonymous callers, customers AND common admins", async () => {
  for (const [method, url, body] of superEndpoints) {
    assert.equal((await call(method, url, { body })).status, 401, `${url} anonymous`);
    assert.equal((await call(method, url, { as: ids.customer, body })).status, 403, `${url} customer`);
    assert.equal((await call(method, url, { as: ids.admin, body })).status, 403, `${url} admin`);
  }
});

test("customer return endpoints are customers only", async () => {
  assert.equal((await call("POST", "/api/returns", { body: {} })).status, 401);
  assert.equal((await call("POST", "/api/returns", { as: ids.admin, body: {} })).status, 403);
});

// ======================================================= role confirmation
test("role change: code e-mailed to the requester, applied once, audited, others notified", async () => {
  const result = await changeRole(ids.owner, ids.customer, "admin");
  assert.equal(result.requested.status, 200);
  assert.ok(!JSON.stringify(result.requested.json).includes(result.code), "code is never returned to the browser");
  assert.equal(mails[0].to, "o@example.com", "code goes to the requesting Super Admin");

  assert.equal(result.confirmed.status, 200);
  assert.equal(db.accounts.find((a) => a.id === ids.customer).role, "admin");
  assert.equal(result.confirmed.json.sessionsRevoked, true);
  assert.ok(db.revocations.has(ids.customer));

  const entry = db.audit.find((a) => a.action === "user.role_change");
  assert.equal(entry.actor_id, ids.owner);
  assert.equal(entry.resource_id, ids.customer);
  assert.match(entry.before_value, /"role":"customer"/);
  assert.match(entry.after_value, /"role":"admin"/);
  assert.equal(entry.reason, "Store needs another admin");

  // Both active Super Admins were told.
  assert.equal(result.confirmed.json.notification.attempted, 2);
  assert.equal(result.confirmed.json.notification.delivered, 2);
});

test("role change: a wrong code is refused and counted; the role does not change", async () => {
  const requested = await call("POST", `/api/superadmin/users/${ids.customer}/role/request`, {
    as: ids.owner,
    body: { role: "admin", reason: "Needs admin access" },
  });
  const wrong = lastCode() === "123456" ? "654321" : "123456";
  const r = await call("PATCH", `/api/superadmin/users/${ids.customer}/role`, {
    as: ids.owner,
    body: { role: "admin", reason: "Needs admin access", confirmationId: requested.json.confirmationId, code: wrong },
  });
  assert.equal(r.status, 403);
  assert.equal(db.accounts.find((a) => a.id === ids.customer).role, "customer");
  assert.equal(db.confirmations[0].attempts, 1);
});

test("role change: a code works exactly once (replay and double click are refused)", async () => {
  const confirmation = require(path.join(root, "services", "admin-confirmation.service.js"));
  const requested = await confirmation.request({
    actor: { id: ids.owner, email: "o@example.com" },
    action: "role_change",
    targetId: ids.customer,
    newRole: "admin",
    reason: "Needs admin access",
    summary: "test",
  });
  const code = lastCode();
  const args = {
    id: requested.confirmationId,
    code,
    actor: { id: ids.owner },
    action: "role_change",
    targetId: ids.customer,
    newRole: "admin",
  };
  assert.deepEqual(await confirmation.consume(args), { reason: "Needs admin access" });
  await assert.rejects(confirmation.consume(args), (e) => e.statusCode === 403);
});

test("role change: expired codes, another user's code and a different change are refused", async () => {
  const confirmation = require(path.join(root, "services", "admin-confirmation.service.js"));
  const base = {
    actor: { id: ids.owner, email: "o@example.com" },
    action: "role_change",
    targetId: ids.customer,
    newRole: "admin",
    reason: "Needs admin access",
    summary: "test",
  };
  const requested = await confirmation.request(base);
  const code = lastCode();
  const use = (over) =>
    confirmation.consume({ id: requested.confirmationId, code, actor: { id: ids.owner }, action: "role_change", targetId: ids.customer, newRole: "admin", ...over });

  await assert.rejects(use({ actor: { id: ids.second } }), (e) => e.statusCode === 403, "another Super Admin cannot use it");
  await assert.rejects(use({ newRole: "superadmin" }), (e) => e.statusCode === 403, "different role");
  await assert.rejects(use({ targetId: ids.buyer }), (e) => e.statusCode === 403, "different target");

  confirmationsLive = false;
  await assert.rejects(use({}), (e) => e.statusCode === 403, "expired");
});

test("role change: no confirmation, an admin caller, bad targets and rules are all refused", async () => {
  // Needs a code.
  let r = await call("PATCH", `/api/superadmin/users/${ids.customer}/role`, { as: ids.owner, body: { role: "admin" } });
  assert.equal(r.status, 428);
  // Common admins cannot even ask.
  r = await call("POST", `/api/superadmin/users/${ids.customer}/role/request`, { as: ids.admin, body: { role: "superadmin", reason: "Trying to elevate" } });
  assert.equal(r.status, 403);
  // Not oneself.
  r = await call("POST", `/api/superadmin/users/${ids.owner}/role/request`, { as: ids.owner, body: { role: "customer", reason: "Demote myself" } });
  assert.equal(r.status, 403);
  // Reason is required.
  r = await call("POST", `/api/superadmin/users/${ids.customer}/role/request`, { as: ids.owner, body: { role: "admin", reason: "x" } });
  assert.equal(r.status, 400);
  assert.equal(db.accounts.find((a) => a.id === ids.customer).role, "customer");
  assert.equal(db.confirmations.length, 0);
});

test("role change: if the code e-mail cannot be sent nothing is changed and the user is told", async () => {
  mailShouldFail = true;
  const r = await call("POST", `/api/superadmin/users/${ids.customer}/role/request`, { as: ids.owner, body: { role: "admin", reason: "Needs admin access" } });
  assert.equal(r.status, 502);
  assert.equal(db.accounts.find((a) => a.id === ids.customer).role, "customer");
});

test("role change: failed notification e-mails are reported, not claimed as delivered", async () => {
  const requested = await call("POST", `/api/superadmin/users/${ids.customer}/role/request`, { as: ids.owner, body: { role: "admin", reason: "Needs admin access" } });
  const code = lastCode();
  failMailTo = "s@example.com";
  const r = await call("PATCH", `/api/superadmin/users/${ids.customer}/role`, {
    as: ids.owner,
    body: { role: "admin", reason: "Needs admin access", confirmationId: requested.json.confirmationId, code },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.notification.attempted, 2);
  assert.equal(r.json.notification.delivered, 1);
  assert.equal(r.json.notification.failed, 1);
});

test("last active Super Admin cannot be demoted even with a valid flow", async () => {
  db.accounts.find((a) => a.id === ids.second).is_active = 0;
  const r = await call("POST", `/api/superadmin/users/${ids.owner}/role/request`, { as: ids.second, body: { role: "customer", reason: "Demote the owner" } });
  assert.ok([401, 403, 409].includes(r.status));
  assert.equal(db.accounts.find((a) => a.id === ids.owner).role, "superadmin");
});

// ======================================================= invitations
test("admin invitation: Super Admin only, confirmed, random password, audited", async () => {
  const body = { email: "New.Admin@Example.com", fullName: "New Admin", reason: "Hired a store assistant" };
  const requested = await call("POST", "/api/superadmin/admins/request", { as: ids.owner, body });
  assert.equal(requested.status, 200);
  const code = lastCode();

  // Without the code nothing is created.
  assert.equal((await call("POST", "/api/superadmin/admins", { as: ids.owner, body })).status, 428);
  assert.equal(db.accounts.some((a) => a.email === "new.admin@example.com"), false);

  const created = await call("POST", "/api/superadmin/admins", {
    as: ids.owner,
    body: { ...body, confirmationId: requested.json.confirmationId, code },
  });
  assert.equal(created.status, 201);
  const account = db.accounts.find((a) => a.email === "new.admin@example.com");
  assert.equal(account.role, "admin");
  assert.ok(account.password_hash && account.password_hash.startsWith("$2"), "stored as a bcrypt hash of a random value");
  assert.ok(!JSON.stringify(created.json).includes(account.password_hash));
  assert.equal(created.json.inviteEmailSent, true);
  assert.ok(auditActions().includes("admin.invite"));

  // The same code cannot create a second account.
  const replay = await call("POST", "/api/superadmin/admins", {
    as: ids.owner,
    body: { ...body, email: "other@example.com", confirmationId: requested.json.confirmationId, code },
  });
  assert.equal(replay.status, 403);
  assert.equal(db.accounts.some((a) => a.email === "other@example.com"), false);
});

test("admin invitation: duplicate and invalid e-mails are rejected", async () => {
  let r = await call("POST", "/api/superadmin/admins/request", { as: ids.owner, body: { email: "c@example.com", fullName: "Dup Licate", reason: "Hired a store assistant" } });
  assert.equal(r.status, 409);
  r = await call("POST", "/api/superadmin/admins/request", { as: ids.owner, body: { email: "not-an-email", fullName: "Bad Mail", reason: "Hired a store assistant" } });
  assert.equal(r.status, 400);
});

// ======================================================= sessions
test("sign out everywhere: earlier tokens stop working, newer ones do", async () => {
  const old = token(ids.admin);
  assert.equal((await call("GET", "/api/admin/security", { authToken: old })).status, 200);

  const out = await call("POST", "/api/admin/security/sign-out-everywhere", { authToken: old });
  assert.equal(out.status, 200);
  assert.ok(auditActions().includes("security.sign_out_everywhere"));

  assert.equal((await call("GET", "/api/admin/security", { authToken: old })).status, 401);

  const later = token(ids.admin, { iat: Math.floor(Date.now() / 1000) + 5 });
  assert.equal((await call("GET", "/api/admin/security", { authToken: later })).status, 200);
});

test("deactivating an account revokes its sessions; re-enabling does not resurrect them", async () => {
  const adminToken = token(ids.admin);
  const off = await call("PATCH", `/api/superadmin/users/${ids.admin}/status`, { as: ids.owner, body: { isActive: false } });
  assert.equal(off.status, 200);
  assert.equal(off.json.sessionsRevoked, true);
  assert.ok(auditActions().includes("user.deactivate"));

  await call("PATCH", `/api/superadmin/users/${ids.admin}/status`, { as: ids.owner, body: { isActive: true } });
  assert.equal((await call("GET", "/api/admin/security", { authToken: adminToken })).status, 401);
});

test("login history is available to the account owner only", async () => {
  db.logins.push({ id: "l1", user_id: ids.admin, method: "otp", ip: "1.2.3.4", user_agent: "test", created_at: "2026-10-29T09:00:00.000Z" });
  db.logins.push({ id: "l2", user_id: ids.owner, method: "google", ip: "9.9.9.9", user_agent: "test", created_at: "2026-10-29T09:00:00.000Z" });
  const r = await call("GET", "/api/admin/security", { as: ids.admin });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.logins.map((l) => l.id), ["l1"]);
});

// ======================================================= review moderation
test("moderation: reason required, hide removes it from the public list, unhide restores it", async () => {
  const reviewService = require(path.join(root, "services", "review.service.js"));
  const publicIds = async () => (await reviewService.getReviews({ slug: "tee" })).reviews.map((r) => r.id);

  assert.deepEqual((await publicIds()).sort(), ["rv_1", "rv_2"]);

  let r = await call("PATCH", "/api/admin/reviews/rv_2/moderation", { as: ids.admin, body: { action: "hide" } });
  assert.equal(r.status, 400, "reason is required");

  r = await call("PATCH", "/api/admin/reviews/rv_2/moderation", { as: ids.admin, body: { action: "hide", reason: "Abusive language" } });
  assert.equal(r.status, 200);
  assert.deepEqual(await publicIds(), ["rv_1"]);
  const summary = (await reviewService.getReviews({ slug: "tee" })).summary;
  assert.equal(summary.count, 1, "hidden reviews are left out of the totals too");
  assert.equal(summary.average, 5);
  assert.equal(db.reviews.length, 2, "the review itself is never deleted");

  // Same state again is refused and not logged twice.
  r = await call("PATCH", "/api/admin/reviews/rv_2/moderation", { as: ids.admin, body: { action: "hide", reason: "Abusive language" } });
  assert.equal(r.status, 409);
  assert.equal(auditActions().filter((a) => a === "review.hide").length, 1);

  r = await call("PATCH", "/api/admin/reviews/rv_2/moderation", { as: ids.owner, body: { action: "unhide", reason: "Reported by mistake" } });
  assert.equal(r.status, 200);
  assert.deepEqual((await publicIds()).sort(), ["rv_1", "rv_2"]);

  const hide = db.audit.find((a) => a.action === "review.hide");
  assert.equal(hide.actor_id, ids.admin);
  assert.equal(hide.reason, "Abusive language");
});

test("moderation: unknown review is a 404; admin list works", async () => {
  assert.equal((await call("PATCH", "/api/admin/reviews/rv_missing/moderation", { as: ids.admin, body: { action: "hide", reason: "Does not exist" } })).status, 404);
  const list = await call("GET", "/api/admin/reviews", { as: ids.admin });
  assert.equal(list.status, 200);
  assert.equal(list.json.reviews.length, 2);
});

// ======================================================= returns
// The return lifecycle, cancellations and refunds are tested against a real MySQL
// with a simulated Razorpay: tests/integration/cancel-return-refund.integration.js
// (and the pure refund maths in refund-calc.test.js).

test("returns: only the owner can change the policy", async () => {
  const body = { enabled: true, windowDays: 7 };
  assert.equal((await call("PUT", "/api/admin/settings/returns", { as: ids.admin, body })).status, 403);
  assert.equal((await call("PUT", "/api/admin/settings/returns", { as: ids.owner, body })).status, 200);
  assert.ok(auditActions().includes("settings.update"));
});

test("returns: admins cannot reach customer return endpoints and customers cannot reach admin ones", async () => {
  assert.equal((await call("POST", "/api/returns", { as: ids.admin, body: {} })).status, 403);
  assert.equal((await call("POST", "/api/returns/preview", { body: {} })).status, 401);
  for (const [method, url] of [
    ["PATCH", `/api/admin/returns/${uuid(50)}/shipped`],
    ["PATCH", `/api/admin/returns/${uuid(50)}/receive`],
    ["PATCH", `/api/admin/returns/${uuid(50)}/inspect`],
    ["POST", `/api/admin/returns/${uuid(50)}/refund`],
    ["GET", "/api/admin/reports/returns"],
    ["GET", "/api/admin/returns-options"],
  ]) {
    const body = method === "GET" ? undefined : {};
    assert.equal((await call(method, url, { body })).status, 401, `${url} anonymous`);
    assert.equal((await call(method, url, { as: ids.customer, body })).status, 403, `${url} customer`);
  }
  assert.equal((await call("GET", "/api/admin/returns/not-a-uuid", { as: ids.admin })).status, 400);
});

// ======================================================= inventory history
test("inventory history: retried operations do not duplicate entries", async () => {
  const history = require(path.join(root, "services", "inventory-history.service.js"));
  const entry = {
    variantId: "v1",
    delta: -1,
    reason: "Order placed",
    source: "order_placed",
    referenceType: "order",
    referenceId: "o9",
    actorId: ids.buyer,
    dedupeKey: "order_placed:o9:v1",
  };
  db.variants[0].inventory = 4;
  assert.equal(await history.recordVariantDelta(connection, entry), true);
  assert.equal(await history.recordVariantDelta(connection, entry), false);
  assert.equal(db.movements.length, 1);
  assert.equal(db.movements[0].previous_qty, 5);
  assert.equal(db.movements[0].new_qty, 4);
});

test("inventory history: no entry when nothing changed; a failed write never breaks the caller", async () => {
  const history = require(path.join(root, "services", "inventory-history.service.js"));
  assert.equal(await history.record(connection, { productId: "p1", previous: 3, next: 3, reason: "same", source: "admin_edit" }), false);
  const broken = { execute: async () => { throw new Error("table missing"); } };
  assert.equal(await history.record(broken, { productId: "p1", previous: 3, next: 4, reason: "x", source: "admin_edit" }), false);
});

test("inventory history: admins can read it with the quantities and the reason", async () => {
  db.movements.push({
    id: "m1", product_id: "p1", variant_id: "v1", previous_qty: 5, new_qty: 3, delta: -2,
    reason: "Order placed", source: "order_placed", reference_type: "order", reference_id: "o1", actor_id: ids.buyer,
    created_at: "2026-10-29T10:00:00.000Z",
  });
  const r = await call("GET", "/api/admin/inventory/movements?source=order_placed", { as: ids.admin });
  assert.equal(r.status, 200);
  assert.equal(r.json.movements[0].previousQuantity, 5);
  assert.equal(r.json.movements[0].newQuantity, 3);
  assert.equal(r.json.movements[0].change, -2);
  assert.equal(r.json.movements[0].productName, "Tee");
  assert.equal(r.json.movements[0].variant, "M / Black");
  assert.equal((await call("GET", "/api/admin/inventory/movements?source=bogus", { as: ids.admin })).status, 400);
});

// ======================================================= audit trail
test("audit: strips credentials, ignores retries with the same key, never throws", async () => {
  const audit = require(path.join(root, "services", "audit.service.js"));
  const entry = {
    actor: { id: ids.owner, email: "o@example.com", role: "superadmin", ip: "1.1.1.1" },
    action: "test.action",
    resourceType: "thing",
    resourceId: "t1",
    before: { name: "a", password: "hunter2", token: "abc", nested: { apiKey: "k", ok: 1 } },
    after: { name: "b", password_hash: "zzz", couponCode: "SAVE10" },
    dedupeKey: "k1",
  };
  assert.equal(await audit.record(entry), true);
  assert.equal(await audit.record(entry), false, "retry ignored");
  assert.equal(db.audit.length, 1);
  const stored = JSON.stringify(db.audit[0]);
  assert.ok(!/hunter2|abc|zzz|"k"/.test(stored), "no credentials in the log");
  assert.match(stored, /SAVE10/);

  const broken = { execute: async () => { throw new Error("down"); } };
  require(path.join(root, "config", "sql.js")); // stub in place
  const original = pool.execute;
  pool.execute = broken.execute;
  try {
    assert.equal(await audit.record({ ...entry, dedupeKey: "k2" }), false);
  } finally {
    pool.execute = original;
  }
});

test("audit: Super Admin only to read, and the application offers no way to edit or delete", async () => {
  db.audit.push({ id: "a1", action: "x.y", resource_type: "t", outcome: "success", actor_email: "a", created_at: "2026-10-29T10:00:00.000Z" });
  const ok = await call("GET", "/api/superadmin/audit-logs", { as: ids.owner });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.logs.length, 1);
  assert.equal(ok.json.pagination.total, 1);
  assert.equal((await call("GET", "/api/superadmin/audit-logs", { as: ids.admin })).status, 403);

  for (const method of ["PUT", "PATCH", "DELETE", "POST"]) {
    const r = await call(method, "/api/superadmin/audit-logs", { as: ids.owner, body: {} });
    assert.ok([404, 405].includes(r.status), `${method} must not exist (got ${r.status})`);
    const one = await call(method, "/api/superadmin/audit-logs/a1", { as: ids.owner, body: {} });
    assert.ok([404, 405].includes(one.status), `${method} /:id must not exist (got ${one.status})`);
  }
  assert.equal(db.audit.length, 1);

  const source = require("fs").readFileSync(path.join(root, "services", "audit.service.js"), "utf8");
  assert.ok(!/UPDATE\s+audit_logs|DELETE\s+FROM\s+audit_logs/i.test(source));
});

test("audit: filters are validated", async () => {
  assert.equal((await call("GET", "/api/superadmin/audit-logs?from=yesterday", { as: ids.owner })).status, 400);
  db.audit.push({ id: "a1", action: "coupon.delete", resource_type: "coupon", outcome: "success", created_at: "x" });
  db.audit.push({ id: "a2", action: "user.role_change", resource_type: "user", outcome: "success", created_at: "x" });
  const r = await call("GET", "/api/superadmin/audit-logs?action=coupon.delete", { as: ids.owner });
  assert.deepEqual(r.json.logs.map((l) => l.id), ["a1"]);
});

// ======================================================= CSV export
// The refund columns are computed by SQL; the fake mirrors the payment-status rule unless a test overrides them.
const exportRow = (over = {}) => {
  const row = exportRowBase(over);
  const status = String(row.payment_status).toLowerCase();
  if (!("refunded_amount" in over)) row.refunded_amount = status === "refunded" ? row.total_amount : 0;
  if (!("refund_open_amount" in over)) row.refund_open_amount = status === "refund pending" ? row.total_amount : 0;
  return row;
};
const exportRowBase = (over = {}) => ({
  id: "o1", order_number: "KV-1", status: "Delivered", payment_method: "online", payment_status: "Paid",
  subtotal: "900", discount_amount: "0", shipping_amount: "79", tax_amount: "21", total_amount: "1000",
  coupon_code: null, ist_time: "2026-10-28 10:00:00", cursor_time: "2026-10-28 04:30:00.000000", units: 2,
  shipping_name: '=HYPERLINK("http://evil","click")', customer_email: "b@example.com", shipping_phone: "+919999999999",
  shipping_city: "Surat", shipping_state: "Gujarat", shipping_pincode: "395001",
  ...over,
});

test("export: valid CSV with BOM, safe filename, distinct money columns, audited", async () => {
  canned.exportRows = [
    exportRow({ order_number: "KV-1", payment_status: "Paid", total_amount: "1000" }),
    exportRow({ order_number: "KV-2", payment_status: "Refunded", total_amount: "500" }),
    exportRow({ order_number: "KV-3", payment_status: "Refund Pending", total_amount: "300" }),
    exportRow({ order_number: "KV-4", payment_status: "Failed", total_amount: "200" }),
    exportRow({ order_number: "KV-5", payment_status: "Partially Refunded", total_amount: "700", refunded_amount: "250" }),
  ];
  const r = await call("GET", "/api/admin/exports/orders.csv?from=2026-10-01&to=2026-10-28", { as: ids.admin, text: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv; charset=utf-8/);
  assert.match(r.headers.get("content-disposition"), /kovenik-orders_2026-10-01_to_2026-10-28\.csv/);
  assert.ok(r.text.startsWith("﻿"));

  const lines = r.text.slice(1).trim().split("\r\n");
  const header = lines[0].split(",");
  assert.deepEqual(header.slice(10, 15), ["order_total", "coupon_code", "amount_collected", "refunded_confirmed", "refund_pending"]);
  const col = (line, name) => line.split(",")[header.indexOf(name)];
  assert.equal(col(lines[1], "amount_collected"), "1000");
  assert.equal(col(lines[2], "refunded_confirmed"), "500");
  assert.equal(col(lines[2], "amount_collected"), "500");
  assert.equal(col(lines[3], "refund_pending"), "300");
  assert.equal(col(lines[4], "amount_collected"), "0", "failed payment collected nothing");
  assert.equal(col(lines[5], "amount_collected"), "700", "a partly refunded order still collected its full total");
  assert.equal(col(lines[5], "refunded_confirmed"), "250", "only the refunded part is confirmed refunded");

  assert.ok(!header.includes("customer_email"), "admin export carries no customer details");
  assert.ok(!r.text.includes("b@example.com") && !r.text.includes("Surat"));

  const entry = db.audit.find((a) => a.action === "export.orders");
  assert.equal(entry.outcome, "success");
  assert.equal(entry.actor_id, ids.admin);
  assert.match(entry.after_value, /"rows":5/);
  assert.match(entry.after_value, /"includesCustomerDetails":false/);
});

test("export: customer details are Super Admin only, and formulas are neutralised", async () => {
  canned.exportRows = [exportRow()];

  const denied = await call("GET", "/api/admin/exports/orders.csv?includeCustomer=1", { as: ids.admin });
  assert.equal(denied.status, 403);
  assert.equal(db.audit.some((a) => a.action === "export.orders"), false, "nothing was exported");

  const ok = await call("GET", "/api/superadmin/exports/orders.csv?includeCustomer=1&from=2026-10-01&to=2026-10-28", { as: ids.owner, text: true });
  assert.equal(ok.status, 200);
  const body = ok.text.slice(1);
  assert.ok(body.includes("customer_email") && body.includes("b@example.com"));
  assert.ok(!body.includes("street"), "no street address column");
  // The HYPERLINK cell starts with '=' -> must be prefixed, and quoted because of the comma/quotes.
  assert.ok(body.includes(`"'=HYPERLINK(""http://evil"",""click"")"`), body);
  assert.ok(db.audit.find((a) => a.action === "export.orders").after_value.includes('"includesCustomerDetails":true'));
});

test("export: csv cell escaping covers every formula starter, quotes and newlines", () => {
  const { csvCell } = require(path.join(root, "services", "export.service.js"));
  for (const start of ["=", "+", "-", "@", "\t", "\r"]) {
    assert.ok(csvCell(`${start}1+1`).includes(`'${start}`), `starter ${JSON.stringify(start)}`);
  }
  assert.equal(csvCell(-5), "-5", "real numbers are not touched");
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell(null), "");
});

test("export: bad filters and ranges are 400s; sales summary is Super Admin only", async () => {
  assert.equal((await call("GET", "/api/admin/exports/orders.csv?status=Hacked", { as: ids.admin })).status, 400);
  assert.equal((await call("GET", "/api/admin/exports/orders.csv?from=2020-01-01&to=2026-01-01", { as: ids.admin })).status, 400);
  assert.equal((await call("GET", "/api/admin/exports/sales-summary.csv", { as: ids.admin })).status, 404);

  canned.totals = { orders: 2, gross_value: "1500", collected: "1000" };
  canned.dayRows = [{ day: "2026-10-28", orders: 2, gross_value: "1500", collected: "1000", refunded: "0", refund_pending: "0", failed: "0", cancelled: "0" }];
  const ok = await call("GET", "/api/superadmin/exports/sales-summary.csv?from=2026-10-28&to=2026-10-28", { as: ids.owner, text: true });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /TOTAL,2,1500,1000/);
  assert.ok(db.audit.some((a) => a.action === "export.sales_summary"));
});

// ======================================================= financial report
test("financial report: keeps gross, collected, refunded, pending and net apart", async () => {
  canned.totals = {
    orders: 10, gross_value: "10000", subtotal: "9000", discounts: "500", shipping: "790", tax: "710",
    collected: "7000", collected_orders: 7, refunded: "1000", refunded_orders: 1,
    refund_pending: "500", refund_pending_orders: 1, failed: "1500", failed_orders: 2,
    awaiting_payment: "1500", awaiting_payment_orders: 1, cancelled: "1200", cancelled_orders: 2,
    cancelled_after_payment: "1000", returned: "800", returned_orders: 1, cod_return_unrefunded: "300",
    online_collected: "6000", cod_collected: "1000",
  };
  canned.dayRows = [{ day: "2026-10-28", orders: 10, gross_value: "10000", collected: "7000", refunded: "1000", refund_pending: "500", failed: "1500", cancelled: "1200" }];

  const r = await call("GET", "/api/superadmin/reports/financial?from=2026-10-01&to=2026-10-28", { as: ids.owner });
  assert.equal(r.status, 200);
  const t = r.json.data.totals;
  assert.equal(t.grossOrderValue, 10000);
  assert.equal(t.payments.collected, 7000);
  assert.equal(t.refunds.refunded, 1000);
  assert.equal(t.refunds.refundPending, 500);
  assert.equal(t.net.received, 6000, "collected - confirmed refunds");
  assert.equal(t.net.afterPendingRefunds, 5200, "also minus pending refunds and COD returns awaiting manual refund");
  assert.equal(t.payments.byMethod.online + t.payments.byMethod.cod, t.payments.collected, "methods add up to collected");
  assert.ok(r.json.data.notes.some((n) => /confirmed paid back/.test(n)), "limits are stated, not hidden");
  assert.equal(r.json.data.daily.length, 1);
});

test("financial report: SQL counts each order once and takes refunds only from Refunded", () => {
  const source = require("fs").readFileSync(path.join(root, "services", "financial-report.service.js"), "utf8");
  assert.match(source, /refunded: `COALESCE\(SUM\(\$\{refundSql\.refunded\(\)\}\), 0\)`/);
  assert.match(source, /refund_pending: `COALESCE\(SUM\(\$\{refundSql\.openRefund\(\)\}\), 0\)`/);
  assert.match(source, /FROM orders o WHERE o\.created_at >= \? AND o\.created_at < \?/);
  assert.ok(!/\b(INNER|LEFT|RIGHT|CROSS)\s+JOIN\b/i.test(source), "no joins that could multiply rows");
});

test("financial report: bad ranges are refused", async () => {
  assert.equal((await call("GET", "/api/superadmin/reports/financial?from=2026-10-30&to=2026-10-01", { as: ids.owner })).status, 400);
  assert.equal((await call("GET", "/api/superadmin/reports/financial?from=nope", { as: ids.owner })).status, 400);
});
