// Newsletter phase 2 (steps 1 and 2): unsubscribe security + one-click, the single sendable-recipient
// gate, and admin subscriber management with backend authorization. The real app runs over HTTP
// against an in-memory stand-in for MySQL; nothing touches a database or sends an e-mail.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "test-secret-not-used-anywhere-else";
delete process.env.CORS_ORIGINS;

const root = path.join(__dirname, "..");
const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = { customer: uuid(1), admin: uuid(2), owner: uuid(3), admin2: uuid(4) };
const accounts = [
  { id: ids.admin2, email: "a2@example.com", role: "admin", is_active: 1 },
  { id: ids.customer, email: "c@example.com", role: "customer", is_active: 1 },
  { id: ids.admin, email: "a@example.com", role: "admin", is_active: 1 },
  { id: ids.owner, email: "o@example.com", role: "superadmin", is_active: 1 },
];

// ---- in-memory database -------------------------------------------------------------
let subs = [];
let tokens = [];
let audits = [];
let missingTables = false;

const seed = () => {
  const row = (id, email, status, extra = {}) => ({
    id, email, status, source: "home",
    subscribed_at: `2026-11-1${id % 9}T10:00:00Z`,
    confirmed_at: status === "pending" ? null : `2026-11-1${id % 9}T10:05:00Z`,
    unsubscribed_at: status === "unsubscribed" ? "2026-11-15T09:00:00Z" : null,
    ipHash: "f".repeat(64), userAgent: "Secret/1.0", ...extra,
  });
  subs = [
    row(1, "asha@example.com", "active"),
    row(2, "ravi@example.com", "pending"),
    row(3, "meera@example.com", "unsubscribed"),
    row(4, "+evil@example.com", "active"),
    row(5, "a_b@example.com", "active"),
    row(6, "axb@example.com", "active"),
  ];
  tokens = [];
  audits = [];
  missingTables = false;
};
seed();

const hashOf = (t) => crypto.createHash("sha256").update(t).digest("hex");

const filtered = (text, params) => {
  let i = 0;
  let rows = subs;
  if (text.includes("status = ?") && !text.includes("status = 'active'")) {
    const s = params[i++];
    rows = rows.filter((r) => r.status === s);
  }
  if (text.includes("email like ?")) {
    // pattern uses | as the escape character
    const raw = params[i++].slice(1, -1).replace(/\|([|%_])/g, "$1");
    rows = rows.filter((r) => r.email.includes(raw));
  }
  return rows;
};

const run = async (sql, params = []) => {
  const text = norm(sql);

  if (text.startsWith("select revoked_before from session_revocations")) return [[]];
  if (text.startsWith("select id, email, role, is_active from profiles")) return [accounts.filter((a) => a.id === params[0])];
  if (text.startsWith("insert ignore into audit_logs")) {
    audits.push({ action: params[4], outcome: params[7], after: params[10], role: params[3], resourceId: params[6], reason: params[8], before: params[9], all: params });
    return [{ affectedRows: 1 }];
  }

  if (text.includes("newsletter") && missingTables) {
    const e = new Error("no such table");
    e.code = "ER_NO_SUCH_TABLE";
    throw e;
  }

  if (text.startsWith("update newsletter_tokens t join newsletter_subscribers s") && text.includes("t.purpose = 'unsubscribe'")) {
    const k = tokens.find((x) => x.hash === params[0] && x.purpose === "unsubscribe" && !x.usedAt);
    const s = k && subs.find((x) => x.id === k.subscriberId && ["active", "pending"].includes(x.status));
    if (!s) return [{ affectedRows: 0 }];
    k.usedAt = true;
    s.status = "unsubscribed";
    s.unsubscribed_at = "2026-11-16T00:00:00Z";
    return [{ affectedRows: 2 }];
  }
  if (text.startsWith("select s.status from newsletter_tokens t join newsletter_subscribers s")) {
    const k = tokens.find((x) => x.hash === params[0] && x.purpose === "unsubscribe");
    const s = k && subs.find((x) => x.id === k.subscriberId);
    return [s ? [{ status: s.status }] : []];
  }
  if (text.startsWith("insert into newsletter_tokens") && text.includes("'unsubscribe'")) {
    tokens.push({ subscriberId: params[0], purpose: "unsubscribe", hash: params[1], usedAt: false });
    return [{ affectedRows: 1 }];
  }

  if (text.startsWith("select id, email from newsletter_subscribers where status = 'active' and id > ?")) {
    const limit = Number(/limit (\d+)/.exec(text)[1]);
    return [subs.filter((r) => r.status === "active" && r.id > params[0]).sort((a, b) => a.id - b.id).slice(0, limit).map((r) => ({ id: r.id, email: r.email }))];
  }

  if (text.startsWith("select status, count(*) as c from newsletter_subscribers group by status")) {
    const by = {};
    for (const r of subs) by[r.status] = (by[r.status] || 0) + 1;
    return [Object.entries(by).map(([status, c]) => ({ status, c }))];
  }
  if (text.startsWith("select count(*) as c from newsletter_subscribers")) return [[{ c: filtered(text, params).length }]];
  if (text.startsWith("select id, email, status, source, date_format")) {
    const limit = Number(/limit (\d+)/.exec(text)[1]);
    const offset = Number(/offset (\d+)/.exec(text)[1]);
    return [filtered(text, params).slice().sort((a, b) => b.id - a.id).slice(offset, offset + limit)];
  }
  if (text.startsWith("select 1 from newsletter_subscribers limit 1")) return [[{ 1: 1 }]];
  if (text.startsWith("select id, status from newsletter_subscribers where id = ?")) {
    return [subs.filter((r) => String(r.id) === String(params[0])).map((r) => ({ id: r.id, status: r.status }))];
  }
  if (text.startsWith("update newsletter_subscribers set status = 'unsubscribed'")) {
    const s = subs.find((r) => String(r.id) === String(params[0]) && ["active", "pending"].includes(r.status));
    if (!s) return [{ affectedRows: 0 }];
    s.status = "unsubscribed";
    s.unsubscribed_at = "2026-11-16T12:00:00Z";
    return [{ affectedRows: 1 }];
  }
  if (text.startsWith("update newsletter_tokens set used_at = utc_timestamp(6) where subscriber_id = ? and purpose = 'confirm'")) {
    let n = 0;
    for (const k of tokens) if (k.subscriberId === Number(params[0]) && k.purpose === "confirm" && !k.usedAt) { k.usedAt = true; n += 1; }
    return [{ affectedRows: n }];
  }
  if (text.startsWith("select id, email, source, date_format")) {
    return [subs.filter((r) => r.status === "active" && r.id > params[0]).sort((a, b) => a.id - b.id)];
  }
  throw new Error("fake DB: unhandled SQL: " + text);
};
const pool = { execute: run, query: run };

const sqlPath = require.resolve(path.join(root, "config", "sql.js"));
require.cache[sqlPath] = { id: sqlPath, filename: sqlPath, loaded: true, exports: { poolPromise: Promise.resolve(pool) } };
const mailerPath = require.resolve(path.join(root, "config", "mailer"));
const sent = [];
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: { transporter: { sendMail: async (m) => { sent.push(m); } }, getBrevoSender: () => ({ from: { name: "KOVENIK", address: "n@example.test" }, envelopeFrom: "n@example.test" }) },
};

const newsletter = require(path.join(root, "services/newsletter.service"));
const app = require(path.join(root, "app.js"));

let server;
let base;
test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => { seed(); sent.length = 0; });

const bearer = (id) => ({ Authorization: `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" })}` });
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const tokenFor = async (subscriberId) => (await newsletter.buildUnsubscribe(subscriberId, { pool }));

// =======================================================================================
// STEP 1: UNSUBSCRIBE
// =======================================================================================
test("buildUnsubscribe: random per-email token, only its hash stored, RFC 8058 headers", async () => {
  const a = await tokenFor(1);
  const b = await tokenFor(1);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.token, b.token);
  assert.equal(tokens[0].hash, hashOf(a.token));
  assert.ok(!JSON.stringify(tokens).includes(a.token));
  assert.equal(a.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(a.headers["List-Unsubscribe"], /^<https?:\/\/[^>]+\/api\/newsletter\/unsubscribe\/one-click\?token=[A-Za-z0-9_-]{43}>$/);
  assert.match(a.url, /\/newsletter\/unsubscribe\?token=/);
});

test("the unsubscribe page POST flips an active subscriber to unsubscribed", async () => {
  const { token } = await tokenFor(1);
  const res = await post("/api/newsletter/unsubscribe", { token });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).alreadyUnsubscribed, false);
  assert.equal(subs.find((s) => s.id === 1).status, "unsubscribed");
  assert.ok(subs.find((s) => s.id === 1).unsubscribed_at);
});

test("a pending subscriber can also unsubscribe", async () => {
  const { token } = await tokenFor(2);
  assert.equal((await post("/api/newsletter/unsubscribe", { token })).status, 200);
  assert.equal(subs.find((s) => s.id === 2).status, "unsubscribed");
});

test("RFC 8058 one-click: form-encoded POST with the token in the URL unsubscribes", async () => {
  const { token } = await tokenFor(1);
  const res = await fetch(`${base}/api/newsletter/unsubscribe/one-click?token=${token}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  assert.equal(res.status, 200);
  assert.equal(subs.find((s) => s.id === 1).status, "unsubscribed");
});

test("a link is single-use but a repeat still says 'already unsubscribed', not an error", async () => {
  const { token } = await tokenFor(1);
  await post("/api/newsletter/unsubscribe", { token });
  const again = await post("/api/newsletter/unsubscribe", { token });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).alreadyUnsubscribed, true);
});

test("an older e-mail's link also works after the person already unsubscribed", async () => {
  const first = await tokenFor(1);
  const second = await tokenFor(1);
  await post("/api/newsletter/unsubscribe", { token: first.token });
  const res = await post("/api/newsletter/unsubscribe", { token: second.token });
  assert.equal(res.status, 200);
  assert.equal(subs.find((s) => s.id === 1).status, "unsubscribed");
});

test("an unsubscribe link can never switch a subscription back on or affect other people", async () => {
  const { token } = await tokenFor(1);
  await post("/api/newsletter/unsubscribe", { token });
  assert.equal(subs.find((s) => s.id === 1).status, "unsubscribed");
  for (const id of [4, 5, 6]) assert.equal(subs.find((s) => s.id === id).status, "active");
});

test("a confirm-purpose or spent token for a re-activated address is refused", async () => {
  const { token } = await tokenFor(1);
  await post("/api/newsletter/unsubscribe", { token });
  subs.find((s) => s.id === 1).status = "active"; // re-confirmed later through the double opt-in
  const res = await post("/api/newsletter/unsubscribe", { token });
  assert.equal(res.status, 400);
  assert.equal(subs.find((s) => s.id === 1).status, "active");
});

test("malformed, unknown and tampered tokens are all the same 400 and change nothing", async () => {
  const { token } = await tokenFor(1);
  const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  for (const bad of [undefined, null, 7, "", "short", "A".repeat(43), tampered, token + "x", "' OR 1=1 --"]) {
    const res = await post("/api/newsletter/unsubscribe", { token: bad });
    assert.equal(res.status, 400, String(bad));
    assert.equal((await res.json()).code, "TOKEN_INVALID");
  }
  const one = await fetch(`${base}/api/newsletter/unsubscribe/one-click?token=nope`, { method: "POST" });
  assert.equal(one.status, 400);
  assert.equal(subs.find((s) => s.id === 1).status, "active");
});

test("GET on the one-click address changes nothing and redirects to the unsubscribe page", async () => {
  const { token } = await tokenFor(1);
  const res = await fetch(`${base}/api/newsletter/unsubscribe/one-click?token=${token}`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /\/newsletter\/unsubscribe\?token=/);
  assert.equal(subs.find((s) => s.id === 1).status, "active");
  assert.equal((await fetch(`${base}/api/newsletter/unsubscribe/one-click?token=bad`, { redirect: "manual" })).status, 400);
});

test("a confirmation token cannot be used to unsubscribe", async () => {
  tokens.push({ subscriberId: 1, purpose: "confirm", hash: hashOf("c".repeat(43)), usedAt: false });
  assert.equal((await post("/api/newsletter/unsubscribe", { token: "c".repeat(43) })).status, 400);
  assert.equal(subs.find((s) => s.id === 1).status, "active");
});

test("tables not migrated -> honest 503", async () => {
  missingTables = true;
  const res = await post("/api/newsletter/unsubscribe", { token: "A".repeat(43) });
  assert.equal(res.status, 503);
});

test("the sendable-recipient gate returns ONLY active subscribers and drops anyone who unsubscribes", async () => {
  let list = await newsletter.listSendable({}, { pool });
  assert.deepEqual(list.map((r) => r.id), [1, 4, 5, 6]); // not pending (2), not unsubscribed (3)
  const { token } = await tokenFor(5);
  await post("/api/newsletter/unsubscribe", { token });
  list = await newsletter.listSendable({}, { pool });
  assert.deepEqual(list.map((r) => r.id), [1, 4, 6]);
  assert.deepEqual((await newsletter.listSendable({ afterId: 4, limit: 1 }, { pool })).map((r) => r.id), [6]);
});

// =======================================================================================
// STEP 2: ADMIN, AUTHORIZATION
// =======================================================================================
const ROUTES = ["/api/admin/newsletter/stats", "/api/admin/newsletter/subscribers", "/api/admin/newsletter/export.csv"];

test("every admin newsletter route: 401 without a login, 401 for a bad token, 403 for a customer", async () => {
  for (const r of ROUTES) {
    assert.equal((await fetch(base + r)).status, 401, `${r} anonymous`);
    assert.equal((await fetch(base + r, { headers: { Authorization: "Bearer junk" } })).status, 401, `${r} junk`);
    assert.equal((await fetch(base + r, { headers: bearer(ids.customer) })).status, 403, `${r} customer`);
  }
});

test("a deactivated or unknown account is refused", async () => {
  accounts.find((a) => a.id === ids.admin).is_active = 0;
  try {
    assert.equal((await fetch(base + ROUTES[0], { headers: bearer(ids.admin) })).status, 401);
  } finally {
    accounts.find((a) => a.id === ids.admin).is_active = 1;
  }
  assert.equal((await fetch(base + ROUTES[0], { headers: bearer(uuid(99)) })).status, 401);
});

test("Admin and Super Admin both get the same access", async () => {
  for (const who of [ids.admin, ids.owner]) {
    for (const r of ROUTES) assert.equal((await fetch(base + r, { headers: bearer(who) })).status, 200, `${who} ${r}`);
  }
});

test("there are no bulk-send, top-level send or subscriber write routes (campaigns live under /campaigns/:id)", async () => {
  for (const [method, p] of [
    ["POST", "/api/admin/newsletter/send"], ["POST", "/api/admin/newsletter/schedule"],
    ["POST", "/api/admin/newsletter/subscribers"], ["DELETE", "/api/admin/newsletter/subscribers/1"],
    ["PATCH", "/api/admin/newsletter/subscribers/1"],
  ]) {
    const res = await fetch(base + p, { method, headers: { ...bearer(ids.owner), "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
    assert.equal(res.status, 404, `${method} ${p}`);
  }
});

// =======================================================================================
// STEP 2: ADMIN, SUBSCRIBER MANAGEMENT
// =======================================================================================
const getJson = async (p, who = ids.admin) => (await fetch(base + p, { headers: bearer(who) })).json();

test("overview counts: total, active, pending, unsubscribed", async () => {
  const { stats } = await getJson("/api/admin/newsletter/stats");
  assert.deepEqual(stats, { total: 6, active: 4, pending: 1, unsubscribed: 1 });
});

test("list: newest first, with dates, and never leaks consent IP hash or user agent", async () => {
  const data = await getJson("/api/admin/newsletter/subscribers");
  assert.equal(data.success, true);
  assert.deepEqual(data.subscribers.map((s) => s.id), ["6", "5", "4", "3", "2", "1"]);
  const first = data.subscribers.find((s) => s.id === "1");
  assert.match(first.subscribedAt, /^2026-11-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(first.status, "active");
  const text = JSON.stringify(data);
  assert.ok(!/ipHash|ip_hash|userAgent|user_agent|Secret\/1\.0|f{64}/.test(text));
  assert.deepEqual(data.pagination, { page: 1, limit: 25, total: 6, totalPages: 1 });
});

test("pagination", async () => {
  const p1 = await getJson("/api/admin/newsletter/subscribers?limit=4&page=1");
  const p2 = await getJson("/api/admin/newsletter/subscribers?limit=4&page=2");
  assert.equal(p1.subscribers.length, 4);
  assert.equal(p2.subscribers.length, 2);
  assert.equal(p1.pagination.totalPages, 2);
  assert.deepEqual([...p1.subscribers, ...p2.subscribers].map((s) => s.id).sort(), ["1", "2", "3", "4", "5", "6"]);
  assert.equal((await getJson("/api/admin/newsletter/subscribers?limit=100000")).pagination.limit, 100); // capped
});

test("filter by status, and an unknown status is a 400", async () => {
  for (const [status, count] of [["active", 4], ["pending", 1], ["unsubscribed", 1]]) {
    const data = await getJson(`/api/admin/newsletter/subscribers?status=${status}`);
    assert.equal(data.pagination.total, count, status);
    assert.ok(data.subscribers.every((s) => s.status === status));
  }
  const bad = await fetch(base + "/api/admin/newsletter/subscribers?status=bounced", { headers: bearer(ids.admin) });
  assert.equal(bad.status, 400);
});

test("search by email is case-insensitive and treats % and _ as plain characters", async () => {
  assert.deepEqual((await getJson("/api/admin/newsletter/subscribers?search=ASHA")).subscribers.map((s) => s.email), ["asha@example.com"]);
  // '_' must not behave as a one-character wildcard: "a_b" must NOT match "axb".
  assert.deepEqual((await getJson("/api/admin/newsletter/subscribers?search=a_b")).subscribers.map((s) => s.email), ["a_b@example.com"]);
  assert.equal((await getJson("/api/admin/newsletter/subscribers?search=%25")).pagination.total, 0);
  assert.equal((await getJson("/api/admin/newsletter/subscribers?search=nobody")).pagination.total, 0);
  // status + search combine
  assert.equal((await getJson("/api/admin/newsletter/subscribers?search=example&status=pending")).pagination.total, 1);
});

test("search input is bound as a parameter (SQL injection text is just text)", async () => {
  const data = await getJson("/api/admin/newsletter/subscribers?search=" + encodeURIComponent("' OR 1=1 --"));
  assert.equal(data.pagination.total, 0);
});

test("CSV export contains ONLY active subscribers, is audited, and cannot run formulas", async () => {
  const res = await fetch(base + "/api/admin/newsletter/export.csv", { headers: bearer(ids.owner) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="kovenik-newsletter-subscribers_\d{4}-\d\d-\d\d\.csv"/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.text()).replace(/^\uFEFF/, "");
  const lines = body.trim().split("\r\n");
  assert.equal(lines[0], "email,subscribed_at_utc,confirmed_at_utc,source");
  const emails = lines.slice(1).map((l) => l.split(",")[0]);
  assert.deepEqual(emails.sort(), ["'+evil@example.com", "a_b@example.com", "asha@example.com", "axb@example.com"].sort());
  assert.ok(!body.includes("ravi@example.com"), "pending must not be exported");
  assert.ok(!body.includes("meera@example.com"), "unsubscribed must not be exported");
  assert.ok(!/ipHash|Secret\/1\.0/.test(body));

  const log = audits.find((a) => a.action === "export.newsletter");
  assert.ok(log, "export must be written to the audit trail");
  assert.equal(log.outcome, "success");
  assert.equal(log.role, "superadmin");
  assert.match(log.after, /"rows":4/);
});

test("CSV export is rate limited per account", async () => {
  let limited = false;
  for (let i = 0; i < 8; i += 1) {
    const res = await fetch(base + "/api/admin/newsletter/export.csv", { headers: bearer(ids.admin) });
    await res.text();
    if (res.status === 429) limited = true;
  }
  assert.ok(limited);
});

test("tables not migrated -> admin gets an honest 503, not a crash or a broken download", async () => {
  missingTables = true;
  for (const r of ROUTES) {
    const res = await fetch(base + r, { headers: bearer(ids.owner) });
    assert.equal(res.status, 503, r);
    assert.equal((await res.json()).code, "NEWSLETTER_NOT_AVAILABLE");
  }
});

// =======================================================================================
// ONE-CLICK RATE LIMITING AT CAMPAIGN SCALE
// =======================================================================================
const randomToken = () => crypto.randomBytes(32).toString("base64url");
const oneClick = (token) =>
  fetch(`${base}/api/newsletter/unsubscribe/one-click?token=${token}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });

test("one-click: hundreds of different recipients from ONE shared proxy IP are never rate limited", async () => {
  // Far past both the old 30-per-15-minutes limit and the app-wide 300-per-minute ceiling.
  const statuses = new Set();
  for (let i = 0; i < 400; i += 1) statuses.add((await oneClick(randomToken())).status);
  assert.deepEqual([...statuses], [400]); // every one reached the token check; none was 429
});

test("one-click: real recipients from the same IP all succeed", async () => {
  const people = [];
  for (let i = 0; i < 40; i += 1) {
    const id = 100 + i;
    subs.push({ id, email: `bulk${i}@example.com`, status: "active", source: "home", subscribed_at: "2026-11-01T00:00:00Z", confirmed_at: "2026-11-01T00:01:00Z", unsubscribed_at: null });
    people.push({ id, ...(await tokenFor(id)) });
  }
  for (const p of people) assert.equal((await oneClick(p.token)).status, 200);
  assert.ok(people.every((p) => subs.find((s) => s.id === p.id).status === "unsubscribed"));
});

test("one-click: a single token is still capped (replay protection), and stays single-use", async () => {
  const { token } = await tokenFor(1);
  const codes = [];
  for (let i = 0; i < 14; i += 1) codes.push((await oneClick(token)).status);
  assert.equal(codes[0], 200);
  assert.ok(codes.slice(1, 10).every((c) => c === 200), "repeats within the cap say 'already unsubscribed'");
  assert.ok(codes.slice(10).every((c) => c === 429), "beyond 10 attempts on one token is refused");
  assert.equal(subs.find((s) => s.id === 1).status, "unsubscribed");
});

test("one-click: a malformed token is refused without a database lookup", async () => {
  let lookups = 0;
  const original = pool.execute;
  pool.execute = async (sql, params) => { if (norm(sql).includes("newsletter_tokens")) lookups += 1; return original(sql, params); };
  try {
    for (const bad of ["x", "A".repeat(42), "A".repeat(44), "../../etc/passwd", "%00"]) {
      assert.equal((await oneClick(bad)).status, 400);
    }
  } finally {
    pool.execute = original;
  }
  assert.equal(lookups, 0);
});

test("the human unsubscribe button keeps its own per-IP limit (separate from one-click)", async () => {
  // Distinct tokens: any 429 here can only come from the per-IP limit on this endpoint.
  let limited = false;
  for (let i = 0; i < 35; i += 1) if ((await post("/api/newsletter/unsubscribe", { token: randomToken() })).status === 429) limited = true;
  assert.ok(limited);
  // ...and one-click from the same IP is unaffected.
  assert.equal((await oneClick(randomToken())).status, 400);
});

// =======================================================================================
// MANUAL UNSUBSCRIBE IN ADMIN
// =======================================================================================
const adminUnsub = (id, body, who = ids.admin) =>
  fetch(`${base}/api/admin/newsletter/subscribers/${id}/unsubscribe`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(who) },
    body: JSON.stringify(body),
  });
const GOOD = { confirm: true, reason: "Asked by email to be removed" };
const SUBSCRIBER_EMAILS = /(asha|ravi|meera|evil|a_b|axb|bulk\d+|bounced)@example\.com/;

test("manual unsubscribe: 401 anonymous, 403 customer", async () => {
  const anon = await fetch(`${base}/api/admin/newsletter/subscribers/1/unsubscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(GOOD) });
  assert.equal(anon.status, 401);
  assert.equal((await adminUnsub(1, GOOD, ids.customer)).status, 403);
  assert.equal(subs.find((s) => s.id === 1).status, "active");
});

test("manual unsubscribe: Admin and Super Admin can, and it is audited without the email address", async () => {
  for (const [who, id, role] of [[ids.admin, 1, "admin"], [ids.owner, 4, "superadmin"]]) {
    const res = await adminUnsub(id, GOOD, who);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "unsubscribed");
    assert.equal(body.changed, true);
    assert.equal(subs.find((s) => s.id === id).status, "unsubscribed");
    const log = audits.find((a) => a.action === "newsletter.unsubscribe" && a.role === role);
    assert.ok(log, `${role} action must be audited`);
    assert.equal(log.resourceId, String(id));
    assert.equal(log.reason, GOOD.reason);
    assert.match(log.before, /"active"/);
    assert.match(log.after, /unsubscribed/);
    assert.ok(!SUBSCRIBER_EMAILS.test(JSON.stringify(log.all)), "no subscriber email address in the audit entry");
  }
});

test("manual unsubscribe: a pending subscriber can be removed and its confirm link is killed", async () => {
  tokens.push({ subscriberId: 2, purpose: "confirm", hash: "h".repeat(64), usedAt: false });
  assert.equal((await adminUnsub(2, GOOD)).status, 200);
  assert.equal(subs.find((s) => s.id === 2).status, "unsubscribed");
  assert.equal(tokens.find((k) => k.purpose === "confirm").usedAt, true, "stale confirm link must stop working");
});

test("manual unsubscribe needs explicit confirmation", async () => {
  for (const bad of [{ reason: GOOD.reason }, { ...GOOD, confirm: false }, { ...GOOD, confirm: "true" }, { ...GOOD, confirm: 1 }, {}]) {
    const res = await adminUnsub(1, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal((await res.json()).code, "CONFIRM_REQUIRED");
  }
  assert.equal(subs.find((s) => s.id === 1).status, "active");
  assert.equal(audits.filter((a) => a.action === "newsletter.unsubscribe").length, 0);
});

test("manual unsubscribe needs a written reason", async () => {
  for (const reason of [undefined, "", "   ", "no", "x".repeat(501), 42]) {
    const res = await adminUnsub(1, { confirm: true, reason });
    assert.equal(res.status, 400, String(reason).slice(0, 10));
  }
  assert.equal(subs.find((s) => s.id === 1).status, "active");
  assert.equal(audits.length, 0);
});

test("manual unsubscribe: unknown or malformed ids are 404 and change nothing", async () => {
  for (const id of ["9999", "abc", "1%3BDROP", "-1", "1.5", "0x1"]) {
    assert.equal((await adminUnsub(id, GOOD)).status, 404, id);
  }
  assert.deepEqual(subs.map((s) => s.status), ["active", "pending", "unsubscribed", "active", "active", "active"]);
});

test("manual unsubscribe NEVER reactivates: already-unsubscribed stays so, with no audit entry", async () => {
  const before = subs.find((s) => s.id === 3).unsubscribed_at;
  const res = await adminUnsub(3, GOOD);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.alreadyUnsubscribed, true);
  assert.equal(body.changed, false);
  assert.equal(subs.find((s) => s.id === 3).status, "unsubscribed");
  assert.equal(subs.find((s) => s.id === 3).unsubscribed_at, before);
  assert.equal(audits.filter((a) => a.action === "newsletter.unsubscribe").length, 0);
});

test("manual unsubscribe cannot be turned into an activation (extra fields ignored, no activate route)", async () => {
  await adminUnsub(3, { ...GOOD, status: "active", action: "activate" });
  assert.equal(subs.find((s) => s.id === 3).status, "unsubscribed");
  for (const [method, p] of [
    ["POST", "/api/admin/newsletter/subscribers/3/activate"], ["POST", "/api/admin/newsletter/subscribers/3/resubscribe"],
    ["PATCH", "/api/admin/newsletter/subscribers/3"], ["PUT", "/api/admin/newsletter/subscribers/3"],
  ]) {
    const res = await fetch(base + p, { method, headers: { ...bearer(ids.owner), "content-type": "application/json" }, body: JSON.stringify({ status: "active" }) });
    assert.equal(res.status, 404, `${method} ${p}`);
  }
  assert.equal(subs.find((s) => s.id === 3).status, "unsubscribed");
});

test("manual unsubscribe leaves statuses it may not change alone", async () => {
  subs.push({ id: 50, email: "bounced@example.com", status: "bounced", source: "home", subscribed_at: "2026-11-01T00:00:00Z", confirmed_at: null, unsubscribed_at: null });
  const res = await adminUnsub(50, GOOD);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.changed, false);
  assert.equal(subs.find((s) => s.id === 50).status, "bounced");
  assert.equal(audits.length, 0);
});

test("an unsubscribed (by admin) address leaves the sendable list at once", async () => {
  assert.ok((await newsletter.listSendable({}, { pool })).some((r) => r.id === 1));
  await adminUnsub(1, GOOD);
  assert.ok(!(await newsletter.listSendable({}, { pool })).some((r) => r.id === 1));
});

// =======================================================================================
// SUBSCRIBER-LIST ACCESS AUDIT
// =======================================================================================
test("viewing the list is audited once per admin per window, without personal data", async () => {
  const a = await fetch(base + "/api/admin/newsletter/subscribers?search=asha&status=active&page=1", { headers: bearer(ids.admin2) });
  assert.equal(a.status, 200);
  await fetch(base + "/api/admin/newsletter/subscribers?page=1", { headers: bearer(ids.admin2) });
  await fetch(base + "/api/admin/newsletter/subscribers?search=ravi", { headers: bearer(ids.admin2) });
  const views = audits.filter((x) => x.action === "newsletter.view_list");
  assert.equal(views.length, 1, "repeat views inside the window are not logged again");
  assert.equal(views[0].role, "admin");
  assert.match(views[0].after, /"status":"active"/);
  assert.match(views[0].after, /"searched":true/);
  const blob = JSON.stringify(views[0].all);
  assert.ok(!/asha|ravi|meera/.test(blob) && !SUBSCRIBER_EMAILS.test(blob), "no search text or subscriber addresses in the audit entry");
});

test("list-view logging: separate window per admin, expires after 10 minutes, filter text never stored", async () => {
  const admin = require(path.join(root, "services/newsletter-admin.service"));
  const logged = [];
  const deps = { audit: async (e) => { logged.push(e); }, now: () => clock };
  let clock = 1_000_000;
  const actorA = { id: "A", role: "admin" };
  const actorB = { id: "B", role: "superadmin" };
  assert.equal(await admin.recordListView({ actor: actorA, search: "secret@x.com", status: "pending", page: 3, total: 9 }, deps), true);
  assert.equal(await admin.recordListView({ actor: actorA, page: 4 }, deps), false);
  assert.equal(await admin.recordListView({ actor: actorB }, deps), true);
  clock += admin.VIEW_LOG_WINDOW_MS + 1;
  assert.equal(await admin.recordListView({ actor: actorA }, deps), true);
  assert.equal(logged.length, 3);
  assert.deepEqual(logged[0].after, { status: "pending", searched: true, page: 3, matching: 9 });
  assert.ok(!JSON.stringify(logged).includes("secret@x.com"));
  // an unknown / hostile status is logged as "all", never echoed
  await admin.recordListView({ actor: { id: "C" }, status: "<script>" }, deps);
  assert.equal(logged[3].after.status, "all");
});

test("CSV export is still audited", async () => {
  await (await fetch(base + "/api/admin/newsletter/export.csv", { headers: bearer(ids.owner) })).text();
  assert.ok(audits.some((a) => a.action === "export.newsletter" && a.outcome === "success"));
});

test("unsubscribe endpoint is rate limited", async () => {
  let limited = false;
  for (let i = 0; i < 35; i += 1) if ((await post("/api/newsletter/unsubscribe", { token: "A".repeat(43) })).status === 429) limited = true;
  assert.ok(limited);
});
