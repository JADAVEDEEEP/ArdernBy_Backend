// Newsletter campaigns: REAL SQL against a throw-away LOCAL MySQL (never the live database).
//
//   NEWSLETTER_TEST_MYSQL=127.0.0.1:3399/kvtest npm test        (user root, empty password)
//
// Without that variable the whole file is skipped, so `npm test` stays runnable anywhere. The target must be
// localhost and the database name must start with "kv"; anything else aborts. The suite creates its own tables
// (and applies the real migration files, twice, to prove they are re-runnable), and sends NO real e-mail:
// the mailer is replaced by an in-memory recorder.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const jwt = require("jsonwebtoken");

const TARGET = process.env.NEWSLETTER_TEST_MYSQL || "";
const SKIP = TARGET ? false : "set NEWSLETTER_TEST_MYSQL=127.0.0.1:<port>/kv<name> to run the database-backed campaign tests";

process.env.JWT_SECRET = "test-secret-not-used-anywhere-else";
process.env.NEWSLETTER_SEND_DELAY_MS = "0";
process.env.NEWSLETTER_POSTAL_PIN = "380015"; // test value only: lets the send-mode footer render
delete process.env.CORS_ORIGINS;
delete process.env.NEWSLETTER_DAILY_LIMIT;

const root = path.join(__dirname, "..");
let pool;
let app;
let server;
let base;
let campaigns;
let sender;
let newsletter;

const sent = [];
let mailBehavior = null; // (mail) => throws / resolves
const sendMail = async (mail) => {
  if (mailBehavior) await mailBehavior(mail);
  sent.push(mail);
};
const senderInfo = () => ({ from: { name: "KOVENIK", address: "noreply@example.test" }, envelopeFrom: "noreply@example.test" });

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = { customer: uuid(1), admin: uuid(2), owner: uuid(3), owner2: uuid(4), admin2: uuid(5) };
const accounts = {
  customer: { id: ids.customer, email: "customer@example.test", role: "customer", ip: "127.0.0.1" },
  admin: { id: ids.admin, email: "admin@example.test", role: "admin", ip: "127.0.0.1" },
  admin2: { id: ids.admin2, email: "admin2@example.test", role: "admin", ip: "127.0.0.1" },
  owner: { id: ids.owner, email: "owner@example.test", role: "superadmin", ip: "127.0.0.1" },
  owner2: { id: ids.owner2, email: "owner2@example.test", role: "superadmin", ip: "127.0.0.1" },
};
const bearer = (who) => ({ Authorization: `Bearer ${jwt.sign({ id: ids[who] }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" })}` });

const q = async (sql, params = []) => (await pool.query(sql, params))[0];
const eventually = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
};

const STUB_SQL = `
CREATE TABLE IF NOT EXISTS profiles (id VARCHAR(64) PRIMARY KEY, email VARCHAR(254) NOT NULL, role VARCHAR(20) NOT NULL, is_active TINYINT(1) NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS session_revocations (user_id VARCHAR(64) NOT NULL PRIMARY KEY, revoked_before BIGINT NOT NULL, updated_at DATETIME(6) NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs (
  id CHAR(36) NOT NULL PRIMARY KEY, created_at DATETIME(6) NOT NULL, actor_id VARCHAR(64) NULL, actor_email VARCHAR(254) NULL, actor_role VARCHAR(20) NULL,
  action VARCHAR(64) NOT NULL, resource_type VARCHAR(40) NOT NULL, resource_id VARCHAR(100) NULL, outcome VARCHAR(12) NOT NULL DEFAULT 'success',
  reason VARCHAR(500) NULL, before_value JSON NULL, after_value JSON NULL, ip VARCHAR(64) NULL, dedupe_key VARCHAR(190) NULL, UNIQUE KEY uq_audit_dedupe (dedupe_key));
CREATE TABLE IF NOT EXISTS products (id VARCHAR(100) PRIMARY KEY, slug VARCHAR(200) NOT NULL UNIQUE, name VARCHAR(200) NOT NULL, price DECIMAL(10,2) NOT NULL);
CREATE TABLE IF NOT EXISTS product_images (id CHAR(36) PRIMARY KEY, product_id VARCHAR(100) NOT NULL, image_url VARCHAR(2048) NOT NULL, sort_order INT NOT NULL DEFAULT 0, is_primary TINYINT(1) NOT NULL DEFAULT 0);
`;

const ALL_TABLES = [
  "newsletter_events", "newsletter_campaign_recipients", "newsletter_campaigns", "newsletter_templates",
  "newsletter_tokens", "newsletter_subscribers", "audit_logs", "product_images", "products", "profiles", "session_revocations",
];

test.before(async () => {
  if (SKIP) return;
  const m = /^(127\.0\.0\.1|localhost):(\d{2,5})\/(kv[A-Za-z0-9_]*)$/.exec(TARGET);
  if (!m) throw new Error("NEWSLETTER_TEST_MYSQL must look like 127.0.0.1:3399/kvtest (local host, database name starting with kv)");
  pool = mysql.createPool({ host: m[1], port: Number(m[2]), user: "root", password: "", database: m[3], multipleStatements: true, waitForConnections: true, connectionLimit: 8 });

  const migrations = ["newsletter_phase1.sql", "newsletter_phase3_campaigns.sql"].map((f) => fs.readFileSync(path.join(root, "scripts", "sql", f), "utf8"));
  await pool.query(STUB_SQL);
  for (const sql of migrations) await pool.query(sql);
  for (const sql of migrations) await pool.query(sql); // re-runnable: the second run must change nothing and not fail

  const sqlPath = require.resolve(path.join(root, "config", "sql.js"));
  require.cache[sqlPath] = { id: sqlPath, filename: sqlPath, loaded: true, exports: { poolPromise: Promise.resolve(pool) } };
  const mailerPath = require.resolve(path.join(root, "config", "mailer"));
  require.cache[mailerPath] = {
    id: mailerPath, filename: mailerPath, loaded: true,
    exports: { transporter: { sendMail }, getBrevoSender: senderInfo },
  };

  newsletter = require(path.join(root, "services", "newsletter.service"));
  campaigns = require(path.join(root, "services", "newsletter-campaign.service"));
  sender = require(path.join(root, "services", "newsletter-sender.service"));
  app = require(path.join(root, "app.js"));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) server.close();
  if (pool) await pool.end();
});

test.beforeEach(async () => {
  if (SKIP) return;
  await pool.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const t of ALL_TABLES) await pool.query(`TRUNCATE TABLE ${t}`);
  await pool.query("SET FOREIGN_KEY_CHECKS = 1");
  for (const a of Object.values(accounts)) await q("INSERT INTO profiles (id, email, role, is_active) VALUES (?, ?, ?, 1)", [a.id, a.email, a.role]);
  sent.length = 0;
  mailBehavior = null;
  process.env.NEWSLETTER_POSTAL_PIN = "380015";
});

// ---- helpers --------------------------------------------------------------------------------

const sub = async (email, status = "active", source = "home") => {
  const [r] = await pool.query(
    `INSERT INTO newsletter_subscribers (email, status, source, consent_text_version, subscribed_at, confirmed_at, created_at, updated_at)
     VALUES (?, ?, ?, 'v1', UTC_TIMESTAMP(6), ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
    [email, status, source, status === "pending" ? null : new Date()]
  );
  return r.insertId;
};
const subStatus = async (id) => (await q("SELECT status FROM newsletter_subscribers WHERE id = ?", [id]))[0].status;

const DESIGN = {
  blocks: [
    { type: "header" },
    { type: "heading", text: "Autumn arrivals" },
    { type: "paragraph", text: "A short, real message for testing." },
    { type: "button", label: "Shop", url: "https://kovenik.in/shop" },
  ],
};
const makeCampaign = (over = {}, who = "owner") =>
  campaigns.create({ name: "Test campaign", subject: "Hello from KOVENIK", preheader: "Preview", design: DESIGN, ...over }, accounts[who]);

const startNow = async (id, expected, who = "owner") => {
  const count = expected ?? (await campaigns.audienceCount(id)).recipients;
  return campaigns.send(id, { confirm: true, expectedRecipients: count }, accounts[who], { kick: false });
};
const tick = (extra = {}) => sender.processTick({ sendMail, sender: senderInfo, config: { delayMs: 0, ...extra.config }, ...extra });
const statusOf = async (id) => (await q("SELECT status FROM newsletter_campaigns WHERE id = ?", [id]))[0].status;
const recipientsOf = async (id) => q("SELECT r.*, s.email FROM newsletter_campaign_recipients r JOIN newsletter_subscribers s ON s.id = r.subscriber_id WHERE r.campaign_id = ? ORDER BY r.id", [id]);
const auditActions = async () => (await q("SELECT action, actor_role, reason, before_value, after_value FROM audit_logs ORDER BY created_at")).map((r) => r);
const call = (method, p, who, body) =>
  fetch(base + p, { method, headers: { "content-type": "application/json", ...(who ? bearer(who) : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

// =======================================================================================
// DATABASE
// =======================================================================================
test("migration: creates exactly the four campaign tables, is re-runnable, and touches nothing else", { skip: SKIP }, async () => {
  const tables = (await q("SELECT TABLE_NAME n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY 1")).map((r) => r.n);
  for (const t of ["newsletter_templates", "newsletter_campaigns", "newsletter_campaign_recipients", "newsletter_events"]) assert.ok(tables.includes(t), t);
  const sqlText = fs.readFileSync(path.join(root, "scripts", "sql", "newsletter_phase3_campaigns.sql"), "utf8");
  assert.doesNotMatch(sqlText.replace(/--.*$/gm, "").replace(/ON DELETE CASCADE/gi, ""), /\b(ALTER|DROP|DELETE|UPDATE|INSERT|TRUNCATE)\b/i, "additive only");
  assert.equal((sqlText.replace(/--.*$/gm, "").match(/CREATE TABLE IF NOT EXISTS/g) || []).length, 4);
  // one delivery row per campaign + subscriber, ever
  const a = await sub("a@example.test");
  const c = await makeCampaign();
  await q("INSERT INTO newsletter_campaign_recipients (campaign_id, subscriber_id, created_at, updated_at) VALUES (?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))", [c.id, a]);
  await assert.rejects(q("INSERT INTO newsletter_campaign_recipients (campaign_id, subscriber_id, created_at, updated_at) VALUES (?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))", [c.id, a]), /Duplicate entry/);
});

// =======================================================================================
// CAMPAIGN CREATION, DRAFTS, TEMPLATES
// =======================================================================================
test("create a campaign: starts as a draft with the default audience; list, read, search and filter", { skip: SKIP }, async () => {
  const c = await makeCampaign({ name: "Welcome 100%_test" });
  assert.equal(c.status, "draft");
  assert.equal(c.audience.type, "all_active");
  assert.equal(c.design.blocks.length, 4);
  await makeCampaign({ name: "Another one", subject: "Different subject" });
  const all = await campaigns.list({});
  assert.equal(all.pagination.total, 2);
  assert.equal((await campaigns.list({ status: "draft" })).pagination.total, 2);
  assert.equal((await campaigns.list({ status: "sent" })).pagination.total, 0);
  assert.equal((await campaigns.list({ search: "100%_" })).pagination.total, 1); // % and _ are literal
  assert.equal((await campaigns.list({ search: "different" })).campaigns[0].name, "Another one");
  assert.equal((await campaigns.list({ limit: 1, page: 2 })).campaigns.length, 1);
  await assert.rejects(campaigns.list({ status: "bogus" }), (e) => e.statusCode === 400);
  await assert.rejects(campaigns.get("abc"), (e) => e.statusCode === 404);
  await assert.rejects(campaigns.get("999999"), (e) => e.statusCode === 404);
});

test("validation: a campaign needs a name; bad designs are refused and nothing is saved", { skip: SKIP }, async () => {
  await assert.rejects(makeCampaign({ name: "  " }), (e) => e.code === "FIELD_REQUIRED");
  await assert.rejects(makeCampaign({ subject: "x".repeat(201) }), (e) => e.statusCode === 400);
  await assert.rejects(makeCampaign({ design: { blocks: [{ type: "hero", imageUrl: "javascript:alert(1)" }] } }), (e) => e.code === "DESIGN_INVALID");
  assert.equal((await campaigns.list({})).pagination.total, 0);
});

test("edit a draft (name, subject, preview text, design); non-drafts cannot be edited", { skip: SKIP }, async () => {
  const c = await makeCampaign();
  const u = await campaigns.update(c.id, { name: "Renamed", subject: "New subject", preheader: "New pre", design: { blocks: [{ type: "heading", text: "Changed" }] } }, accounts.admin);
  assert.equal(u.name, "Renamed");
  assert.equal(u.design.blocks[0].text, "Changed");
  await assert.rejects(campaigns.update(c.id, { design: { blocks: [{ type: "nope" }] } }, accounts.admin), (e) => e.code === "DESIGN_INVALID");
  await sub("a@example.test");
  await campaigns.update(c.id, { design: DESIGN }, accounts.owner);
  await startNow(c.id);
  await assert.rejects(campaigns.update(c.id, { name: "Too late" }, accounts.owner), (e) => e.statusCode === 409 && e.code === "NOT_DRAFT");
});

test("duplicate: a fresh draft with the same content, no schedule, no results, default audience", { skip: SKIP }, async () => {
  const a = await sub("a@example.test");
  const c = await makeCampaign();
  await campaigns.update(c.id, { audienceType: "selected", audienceIds: [a] }, accounts.owner);
  await startNow(c.id);
  await tick();
  const copy = await campaigns.duplicate(c.id, accounts.admin);
  assert.equal(copy.status, "draft");
  assert.equal(copy.name, "Copy of Test campaign");
  assert.deepEqual(copy.design.blocks.map((b) => b.type), DESIGN.blocks.map((b) => b.type));
  assert.equal(copy.audience.type, "all_active");
  assert.equal(copy.scheduledAt, null);
  assert.equal(copy.stats.queued, 0);
  assert.notEqual(copy.id, c.id);
});

test("templates: save, list, load into a new campaign, rename, unique names, delete", { skip: SKIP }, async () => {
  const t = await campaigns.saveTemplate(undefined, { name: "Monthly", subject: "S", preheader: "P", design: DESIGN }, accounts.admin);
  assert.equal((await campaigns.listTemplates()).length, 1);
  assert.equal((await campaigns.getTemplate(t.id)).design.blocks.length, 4);
  const c = await campaigns.create({ name: "From template", templateId: t.id }, accounts.admin);
  assert.equal(c.subject, "S");
  assert.equal(c.design.blocks[1].text, "Autumn arrivals");
  await assert.rejects(campaigns.saveTemplate(undefined, { name: "Monthly", design: DESIGN }, accounts.admin), (e) => e.code === "TEMPLATE_NAME_TAKEN");
  const renamed = await campaigns.saveTemplate(t.id, { name: "Monthly v2", design: DESIGN }, accounts.owner);
  assert.equal(renamed.name, "Monthly v2");
  await assert.rejects(campaigns.saveTemplate(undefined, { name: "Bad", design: { blocks: [{ type: "x" }] } }, accounts.admin), (e) => e.code === "DESIGN_INVALID");
  await campaigns.deleteTemplate(t.id, accounts.admin);
  assert.equal((await campaigns.listTemplates()).length, 0);
  await assert.rejects(campaigns.deleteTemplate(t.id, accounts.admin), (e) => e.statusCode === 404);
});

test("preview renders real catalogue data and warns about a missing product", { skip: SKIP }, async () => {
  await q("INSERT INTO products (id, slug, name, price) VALUES ('p1', 'oxford-shirt', 'Oxford Shirt', 1299.00)");
  await q("INSERT INTO product_images (id, product_id, image_url, is_primary) VALUES (?, 'p1', 'https://cdn.example.com/o.jpg', 1)", [crypto.randomUUID()]);
  const ok = await campaigns.preview({ design: { blocks: [{ type: "product_details", productSlug: "oxford-shirt" }] }, subject: "S" });
  assert.match(ok.html, /Oxford Shirt/);
  assert.match(ok.html, /₹1,299/);
  assert.match(ok.html, /cdn\.example\.com\/o\.jpg/);
  assert.ok(ok.warnings.some((w) => /PIN code/i.test(w)) === false, "PIN is set in this test run");
  const missing = await campaigns.preview({ design: { blocks: [{ type: "product_details", productSlug: "ghost" }] }, subject: "S" });
  assert.ok(missing.warnings.some((w) => /ghost/.test(w)));
  assert.deepEqual((await campaigns.searchProducts("oxford")).map((p) => p.slug), ["oxford-shirt"]);
  assert.deepEqual(await campaigns.searchProducts("%"), []); // wildcard is literal
});

// =======================================================================================
// AUTHORIZATION (over HTTP, against the real app)
// =======================================================================================
test("permissions: Admin can view, draft, edit, duplicate and preview, but NOT choose recipients, test, schedule, send or cancel", { skip: SKIP }, async () => {
  await sub("a@example.test");
  const draft = await call("POST", "/api/admin/newsletter/campaigns", "admin", { name: "By admin", subject: "S", design: DESIGN });
  assert.equal(draft.status, 201);
  const id = (await draft.json()).campaign.id;

  assert.equal((await call("GET", "/api/admin/newsletter/campaigns", "admin")).status, 200);
  assert.equal((await call("GET", "/api/admin/newsletter/overview", "admin")).status, 200);
  assert.equal((await call("GET", `/api/admin/newsletter/campaigns/${id}`, "admin")).status, 200);
  assert.equal((await call("PUT", `/api/admin/newsletter/campaigns/${id}`, "admin", { name: "Edited" })).status, 200);
  assert.equal((await call("POST", `/api/admin/newsletter/campaigns/${id}/duplicate`, "admin")).status, 201);
  assert.equal((await call("POST", "/api/admin/newsletter/preview", "admin", { design: DESIGN, subject: "S" })).status, 200);
  assert.equal((await call("GET", "/api/admin/newsletter/templates", "admin")).status, 200);

  // recipients are a Super Admin decision, at creation and at edit time
  assert.equal((await call("POST", "/api/admin/newsletter/campaigns", "admin", { name: "X", design: DESIGN, audienceType: "selected", audienceIds: [1] })).status, 403);
  assert.equal((await call("PUT", `/api/admin/newsletter/campaigns/${id}`, "admin", { audienceType: "source", audienceSource: "home" })).status, 403);
  assert.equal((await call("PUT", `/api/admin/newsletter/campaigns/${id}`, "admin", { audienceIds: [1] })).status, 403);

  const blocked = [
    ["POST", `/api/admin/newsletter/campaigns/${id}/test`, {}],
    ["POST", `/api/admin/newsletter/campaigns/${id}/schedule`, { scheduledAt: new Date(Date.now() + 3600e3).toISOString(), confirm: true, expectedRecipients: 1 }],
    ["POST", `/api/admin/newsletter/campaigns/${id}/send`, { confirm: true, expectedRecipients: 1 }],
    ["POST", `/api/admin/newsletter/campaigns/${id}/cancel`, {}],
    ["GET", `/api/admin/newsletter/campaigns/${id}/audience-count`],
    ["GET", `/api/admin/newsletter/campaigns/${id}/recipients`],
    ["GET", `/api/admin/newsletter/campaigns/${id}/report.csv`],
    ["GET", "/api/admin/newsletter/sources"],
  ];
  for (const [method, p, body] of blocked) assert.equal((await call(method, p, "admin", body)).status, 403, `admin ${method} ${p}`);
  assert.equal(sent.length, 0);
  assert.equal(await statusOf(id), "draft");
});

test("permissions: customers and anonymous callers get 403 / 401 on every campaign route", { skip: SKIP }, async () => {
  const c = await makeCampaign();
  const routes = [
    ["GET", "/api/admin/newsletter/overview"], ["GET", "/api/admin/newsletter/campaigns"], ["POST", "/api/admin/newsletter/campaigns", { name: "x", design: DESIGN }],
    ["GET", `/api/admin/newsletter/campaigns/${c.id}`], ["PUT", `/api/admin/newsletter/campaigns/${c.id}`, { name: "x" }],
    ["POST", `/api/admin/newsletter/campaigns/${c.id}/duplicate`], ["POST", "/api/admin/newsletter/preview", { design: DESIGN }],
    ["GET", "/api/admin/newsletter/templates"], ["POST", "/api/admin/newsletter/templates", { name: "x", design: DESIGN }],
    ["POST", `/api/admin/newsletter/campaigns/${c.id}/send`, { confirm: true, expectedRecipients: 0 }],
    ["POST", `/api/admin/newsletter/campaigns/${c.id}/schedule`, {}], ["POST", `/api/admin/newsletter/campaigns/${c.id}/cancel`],
    ["POST", `/api/admin/newsletter/campaigns/${c.id}/test`, {}], ["GET", `/api/admin/newsletter/campaigns/${c.id}/recipients`],
    ["GET", `/api/admin/newsletter/campaigns/${c.id}/report.csv`], ["GET", "/api/admin/newsletter/products"],
  ];
  for (const [method, p, body] of routes) {
    assert.equal((await call(method, p, undefined, body)).status, 401, `anon ${method} ${p}`);
    assert.equal((await call(method, p, "customer", body)).status, 403, `customer ${method} ${p}`);
  }
  assert.equal(sent.length, 0);
});

test("permissions: Super Admin passes every gate; Admin never sees the chosen subscriber ids or any e-mail address", { skip: SKIP }, async () => {
  const a = await sub("secret.person@example.test");
  const c = await makeCampaign();
  const set = await call("PUT", `/api/admin/newsletter/campaigns/${c.id}`, "owner", { audienceType: "selected", audienceIds: [a] });
  assert.equal(set.status, 200);
  assert.deepEqual((await set.json()).campaign.audience.ids, [a]);
  assert.equal((await call("GET", `/api/admin/newsletter/campaigns/${c.id}/audience-count`, "owner")).status, 200);
  assert.equal((await call("GET", `/api/admin/newsletter/campaigns/${c.id}/recipients`, "owner")).status, 200);
  assert.equal((await call("GET", "/api/admin/newsletter/sources", "owner")).status, 200);

  const asAdmin = await (await call("GET", `/api/admin/newsletter/campaigns/${c.id}`, "admin")).text();
  assert.ok(!asAdmin.includes("secret.person"));
  assert.equal(JSON.parse(asAdmin).campaign.audience.ids, undefined);
  assert.equal(JSON.parse(asAdmin).campaign.audience.selectedCount, 1);
  const listAsAdmin = await (await call("GET", "/api/admin/newsletter/campaigns", "admin")).text();
  assert.ok(!listAsAdmin.includes("secret.person"));
});

// =======================================================================================
// RECIPIENT SELECTION + ACTIVE-ONLY ENFORCEMENT
// =======================================================================================
test("audiences: all active / selected / signup source, always active-only and de-duplicated", { skip: SKIP }, async () => {
  const a = await sub("a@example.test", "active", "home");
  const b = await sub("b@example.test", "active", "footer");
  const p = await sub("p@example.test", "pending", "home");
  const u = await sub("u@example.test", "unsubscribed", "home");
  const x = await sub("x@example.test", "bounced", "home");
  assert.deepEqual((await newsletter.listSendable({})).map((r) => r.id), [a, b]);
  assert.equal(await newsletter.countSendable({}), 2);
  assert.equal(await newsletter.countSendable({ source: "footer" }), 1);
  assert.equal(await newsletter.countSendable({ ids: [a, p, u, x, a, a] }), 1); // inactive ids and repeats drop out
  assert.equal(await newsletter.countSendable({ ids: [] }), 0);
  assert.equal(await newsletter.countSendable({ ids: ["1; DROP TABLE newsletter_subscribers", -4, 0] }), 0);
  assert.deepEqual((await newsletter.listSendable({ afterId: a, limit: 1 })).map((r) => r.id), [b]);

  const c = await makeCampaign();
  await campaigns.update(c.id, { audienceType: "selected", audienceIds: [a, p, u, a] }, accounts.owner);
  assert.equal((await campaigns.audienceCount(c.id)).recipients, 1);
  await campaigns.update(c.id, { audienceType: "source", audienceSource: "footer" }, accounts.owner);
  assert.equal((await campaigns.audienceCount(c.id)).recipients, 1);
  await campaigns.update(c.id, { audienceType: "all_active" }, accounts.owner);
  assert.equal((await campaigns.audienceCount(c.id)).recipients, 2);
  assert.deepEqual(await campaigns.signupSources(), [{ source: "footer", active: 1 }, { source: "home", active: 1 }]);

  await assert.rejects(campaigns.update(c.id, { audienceType: "everyone" }, accounts.owner), (e) => e.code === "AUDIENCE_INVALID");
  await assert.rejects(campaigns.update(c.id, { audienceIds: ["x"] }, accounts.owner), (e) => e.code === "AUDIENCE_INVALID");
  await assert.rejects(campaigns.update(c.id, { audienceSource: "bad source!" }, accounts.owner), (e) => e.code === "AUDIENCE_INVALID");
  await assert.rejects(campaigns.update(c.id, { audienceIds: Array.from({ length: 1001 }, (_, i) => i + 1) }, accounts.owner), (e) => e.code === "AUDIENCE_INVALID");
});

test("a campaign is only ever sent to ACTIVE subscribers: pending, unsubscribed, bounced and complained never receive it", { skip: SKIP }, async () => {
  const a = await sub("a@example.test");
  const b = await sub("b@example.test");
  await sub("pending@example.test", "pending");
  await sub("gone@example.test", "unsubscribed");
  await sub("bounced@example.test", "bounced");
  await sub("spam@example.test", "complained");
  const c = await makeCampaign();
  await startNow(c.id, 2);
  const summary = await tick();
  assert.equal(summary.sent, 2);
  assert.deepEqual(sent.map((m) => m.to).sort(), ["a@example.test", "b@example.test"]);
  assert.equal(await statusOf(c.id), "sent");
  const rows = await recipientsOf(c.id);
  assert.deepEqual(rows.map((r) => r.subscriber_id).sort(), [a, b].sort());
});

// =======================================================================================
// SENDING: confirmation, compliance, per-recipient records
// =======================================================================================
test("send needs explicit confirmation AND the exact recipient count the admin saw", { skip: SKIP }, async () => {
  await sub("a@example.test");
  await sub("b@example.test");
  const c = await makeCampaign();
  await assert.rejects(campaigns.send(c.id, {}, accounts.owner, { kick: false }), (e) => e.code === "CONFIRM_REQUIRED");
  await assert.rejects(campaigns.send(c.id, { confirm: "yes", expectedRecipients: 2 }, accounts.owner, { kick: false }), (e) => e.code === "CONFIRM_REQUIRED");
  await assert.rejects(campaigns.send(c.id, { confirm: true }, accounts.owner, { kick: false }), (e) => e.code === "AUDIENCE_CHANGED");
  await assert.rejects(campaigns.send(c.id, { confirm: true, expectedRecipients: 1 }, accounts.owner, { kick: false }), (e) => e.code === "AUDIENCE_CHANGED" && e.currentRecipients === 2);
  assert.equal(await statusOf(c.id), "draft");
  assert.equal((await tick()).sent, 0);
  assert.equal(sent.length, 0);
});

test("send is refused when the campaign is not ready: no subject, no content, placeholder text, missing product, PIN unset, nobody to send to", { skip: SKIP }, async () => {
  await sub("a@example.test");
  const go = (c) => campaigns.send(c.id, { confirm: true, expectedRecipients: 1 }, accounts.owner, { kick: false });
  await assert.rejects(go(await makeCampaign({ subject: "" })), (e) => e.code === "SUBJECT_REQUIRED");
  await assert.rejects(go(await makeCampaign({ design: { blocks: [{ type: "header" }, { type: "divider" }] } })), (e) => e.code === "NO_CONTENT");
  await assert.rejects(go(await makeCampaign({ design: { blocks: [{ type: "heading", text: "Write your headline" }] } })), (e) => e.code === "PLACEHOLDER_TEXT");
  await assert.rejects(go(await makeCampaign({ design: { blocks: [{ type: "product_details", productSlug: "ghost" }] } })), (e) => e.code === "PRODUCT_MISSING");
  delete process.env.NEWSLETTER_POSTAL_PIN;
  await assert.rejects(go(await makeCampaign()), (e) => e.statusCode === 409 && e.code === "POSTAL_ADDRESS_INCOMPLETE");
  process.env.NEWSLETTER_POSTAL_PIN = "380015";
  await q("UPDATE newsletter_subscribers SET status = 'unsubscribed'");
  await assert.rejects(campaigns.send((await makeCampaign()).id, { confirm: true, expectedRecipients: 0 }, accounts.owner, { kick: false }), (e) => e.code === "NO_RECIPIENTS");
  assert.equal(sent.length, 0);
});

test("every campaign e-mail carries a visible unsubscribe link, RFC 8058 headers, the postal address and a working single-use token", { skip: SKIP }, async () => {
  const a = await sub("a@example.test");
  await sub("b@example.test");
  const c = await makeCampaign();
  await startNow(c.id, 2);
  await tick();
  assert.equal(sent.length, 2);

  const first = sent.find((m) => m.to === "a@example.test");
  assert.equal(first.subject, "Hello from KOVENIK");
  assert.match(first.headers["List-Unsubscribe"], /^<https?:\/\/[^>]+\/api\/newsletter\/unsubscribe\/one-click\?token=[A-Za-z0-9_-]{43}>$/);
  assert.equal(first.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.equal(first.headers["X-Mailin-Tag"], `kv-c${c.id}`);
  assert.match(first.messageId, new RegExp(`^<kv-c${c.id}-r\\d+@example\\.test>$`));
  assert.match(first.html, />Unsubscribe<\/a>/);
  assert.match(first.html, /href="https?:\/\/[^"]+\/newsletter\/unsubscribe\?token=[A-Za-z0-9_-]{43}"/);
  assert.ok(!first.html.includes("{{unsubscribe_url}}") && !first.text.includes("{{unsubscribe_url}}"), "placeholder must be replaced");
  assert.match(first.html, /Krishna Bunglow 1, New Ranip, Ahmedabad, 380015/);
  assert.match(first.text, /Krishna Bunglow 1, New Ranip, Ahmedabad, 380015/);
  assert.match(first.text, /Unsubscribe: https?:\/\/.+token=/);
  assert.ok(!sent.some((m) => /^\[TEST\]/.test(m.subject)));

  // each recipient has a DIFFERENT token
  const tokens = sent.map((m) => /token=([A-Za-z0-9_-]{43})"/.exec(m.html)[1]);
  assert.notEqual(tokens[0], tokens[1]);
  // the link in the e-mail really unsubscribes (single use), and the delivery row remembers only its hash
  const token = /token=([A-Za-z0-9_-]{43})"/.exec(first.html)[1];
  const row = (await recipientsOf(c.id)).find((r) => r.subscriber_id === a);
  assert.equal(row.unsub_token_hash, newsletter.sha256(token));
  assert.ok(!JSON.stringify(row).includes(token));
  assert.equal((await newsletter.unsubscribe(token)).alreadyUnsubscribed, undefined);
  assert.equal(await subStatus(a), "unsubscribed");
  assert.equal((await newsletter.unsubscribe(token)).alreadyUnsubscribed, true);
});

test("per-recipient delivery records, progress and final status", { skip: SKIP }, async () => {
  await sub("a@example.test");
  await sub("b@example.test");
  await sub("c@example.test");
  const c = await makeCampaign();
  await startNow(c.id, 3);
  assert.equal(await statusOf(c.id), "scheduled");
  await tick({ config: { batchSize: 2 } });
  let progress = await campaigns.get(c.id, accounts.owner);
  assert.equal(progress.status, "sending");
  assert.equal(progress.totalRecipients, 3);
  assert.equal(progress.stats.sent, 2);
  assert.equal(progress.stats.pending, 1);
  assert.equal(progress.completedAt, null);
  await tick({ config: { batchSize: 2 } });
  progress = await campaigns.get(c.id, accounts.owner);
  assert.equal(progress.status, "sent");
  assert.equal(progress.stats.sent, 3);
  assert.equal(progress.stats.pending, 0);
  assert.ok(progress.completedAt);
  assert.ok(Number.isInteger(progress.stats.completionSeconds));
  const rows = await recipientsOf(c.id);
  assert.ok(rows.every((r) => r.status === "sent" && r.sent_at && r.attempts === 1 && r.message_id));
  assert.equal(sent.length, 3);
});

test("batch size and send interval are configurable and respected", { skip: SKIP }, async () => {
  for (let i = 0; i < 5; i += 1) await sub(`p${i}@example.test`);
  const c = await makeCampaign();
  await startNow(c.id, 5);
  const naps = [];
  await sender.processTick({ sendMail, sender: senderInfo, config: { batchSize: 3, delayMs: 250 }, sleep: async (ms) => { naps.push(ms); } });
  assert.equal(sent.length, 3, "never more than the batch size per tick");
  assert.deepEqual(naps, [250, 250, 250], "a pause after every message");
  assert.equal(sender.config().batchSize, 20);
  assert.equal(sender.config().delayMs, 0, "the test environment sets NEWSLETTER_SEND_DELAY_MS=0");
});

// =======================================================================================
// UNSUBSCRIBE SUPPRESSION, DUPLICATE PREVENTION
// =======================================================================================
test("someone who unsubscribes AFTER the campaign was queued is skipped, even a moment before their turn", { skip: SKIP }, async () => {
  const a = await sub("a@example.test");
  const b = await sub("b@example.test");
  const c = await sub("c@example.test");
  const camp = await makeCampaign();
  await startNow(camp.id, 3);
  // the first message goes out, and that very send unsubscribes the next person in line
  mailBehavior = async () => { if (sent.length === 0) await q("UPDATE newsletter_subscribers SET status = 'unsubscribed' WHERE id = ?", [b]); };
  await tick();
  assert.deepEqual(sent.map((m) => m.to), ["a@example.test", "c@example.test"]);
  const rows = await recipientsOf(camp.id);
  const skipped = rows.find((r) => r.subscriber_id === b);
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.error_kind, "not_active");
  assert.equal(await statusOf(camp.id), "sent");
  assert.equal(c > 0 && a > 0, true);
});

test("an unsubscribed person is excluded from every later campaign immediately", { skip: SKIP }, async () => {
  const a = await sub("a@example.test");
  await sub("b@example.test");
  const first = await makeCampaign();
  await startNow(first.id, 2);
  await tick();
  const token = /token=([A-Za-z0-9_-]{43})"/.exec(sent.find((m) => m.to === "a@example.test").html)[1];
  await newsletter.unsubscribe(token);
  sent.length = 0;
  const second = await makeCampaign({ name: "Second" });
  assert.equal((await campaigns.audienceCount(second.id)).recipients, 1);
  await startNow(second.id, 1);
  await tick();
  assert.deepEqual(sent.map((m) => m.to), ["b@example.test"]);
  assert.equal(await subStatus(a), "unsubscribed");
});

test("duplicate-send prevention: repeated and concurrent processing sends each recipient exactly once", { skip: SKIP }, async () => {
  for (let i = 0; i < 6; i += 1) await sub(`d${i}@example.test`);
  const c = await makeCampaign();
  await startNow(c.id, 6);
  // start it (scheduled -> sending) without sending anything yet
  await tick({ config: { batchSize: 1 } });
  sent.length = 0;
  const slow = async (mail) => { await new Promise((r) => setTimeout(r, 15)); void mail; };
  mailBehavior = slow;
  const cfg = { ...sender.config(), batchSize: 20, delayMs: 0 };
  // three workers hammering the same campaign at once (processCampaign bypasses the in-process tick guard)
  await Promise.all([1, 2, 3].map(() => sender.processCampaign(pool, c.id, cfg, { sendMail, sender: senderInfo }, Date.now() + 30000)));
  await tick();
  const all = sent.map((m) => m.to);
  assert.equal(new Set(all).size, all.length, `duplicates: ${all.join(",")}`);
  assert.equal(all.length, 5, "5 left after the first single send");
  const rows = await recipientsOf(c.id);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => r.status === "sent" && r.attempts === 1), "every row claimed exactly once");
  await tick(); await tick();
  assert.equal(sent.length, 5, "re-running a finished campaign sends nothing");
  assert.equal(await statusOf(c.id), "sent");
});

test("campaign lock: a campaign leased to another worker is left alone until the lease expires", { skip: SKIP }, async () => {
  await sub("a@example.test");
  const c = await makeCampaign();
  await startNow(c.id, 1);
  await q("UPDATE newsletter_campaigns SET status = 'sending', started_at = UTC_TIMESTAMP(6), locked_by = 'other-worker', locked_until = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 5 MINUTE) WHERE id = ?", [c.id]);
  const cfg = { ...sender.config(), delayMs: 0 };
  const busy = await sender.processCampaign(pool, c.id, cfg, { sendMail, sender: senderInfo }, Date.now() + 30000);
  assert.equal(busy.paused, "locked");
  assert.equal(sent.length, 0);
  await q("UPDATE newsletter_campaigns SET locked_until = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 MINUTE) WHERE id = ?", [c.id]);
  await tick();
  assert.equal(sent.length, 1, "an expired lease (a crashed worker) is taken over");
  assert.equal(await statusOf(c.id), "sent");
});

test("a campaign can only be started once: a second send or schedule on a campaign already under way is refused", { skip: SKIP }, async () => {
  await sub("a@example.test");
  const c = await makeCampaign();
  await startNow(c.id, 1);
  await tick();
  await assert.rejects(campaigns.send(c.id, { confirm: true, expectedRecipients: 1 }, accounts.owner, { kick: false }), (e) => e.code === "NOT_DRAFT");
  await assert.rejects(campaigns.schedule(c.id, { scheduledAt: new Date(Date.now() + 3600e3).toISOString(), confirm: true, expectedRecipients: 1 }, accounts.owner), (e) => e.code === "NOT_DRAFT");
  assert.equal(sent.length, 1);
});

// =======================================================================================
// SCHEDULING, RECOVERY AFTER RESTARTS, CANCELLATION
// =======================================================================================
test("scheduling: validated, stored in the database, not sent early, sent when due", { skip: SKIP }, async () => {
  await sub("a@example.test");
  const c = await makeCampaign();
  const at = (ms) => new Date(Date.now() + ms).toISOString();
  const ok = { confirm: true, expectedRecipients: 1 };
  await assert.rejects(campaigns.schedule(c.id, { scheduledAt: "tomorrow", ...ok }, accounts.owner), (e) => e.code === "SCHEDULE_INVALID");
  await assert.rejects(campaigns.schedule(c.id, { scheduledAt: at(5000), ...ok }, accounts.owner), (e) => e.code === "SCHEDULE_INVALID");
  await assert.rejects(campaigns.schedule(c.id, { scheduledAt: at(91 * 86400e3), ...ok }, accounts.owner), (e) => e.code === "SCHEDULE_INVALID");
  await assert.rejects(campaigns.schedule(c.id, { scheduledAt: at(3600e3), confirm: false, expectedRecipients: 1 }, accounts.owner), (e) => e.code === "CONFIRM_REQUIRED");

  const when = at(2 * 3600e3);
  const s = await campaigns.schedule(c.id, { scheduledAt: when, ...ok }, accounts.owner);
  assert.equal(s.status, "scheduled");
  assert.equal(s.scheduledAt.slice(0, 16), when.slice(0, 16));

  await tick();
  assert.equal(sent.length, 0, "not due yet");
  assert.equal(await statusOf(c.id), "scheduled");

  // re-scheduling a scheduled campaign is allowed
  const later = at(3 * 3600e3);
  assert.equal((await campaigns.schedule(c.id, { scheduledAt: later, ...ok }, accounts.owner)).scheduledAt.slice(0, 16), later.slice(0, 16));

  await q("UPDATE newsletter_campaigns SET scheduled_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 MINUTE) WHERE id = ?", [c.id]);
  const summary = await tick();
  assert.equal(summary.started, 1);
  assert.equal(sent.length, 1);
  assert.equal(await statusOf(c.id), "sent");
});

test("recovery: a scheduled campaign that came due while the server was down starts on the next tick, no in-memory state needed", { skip: SKIP }, async () => {
  await sub("a@example.test");
  const c = await makeCampaign();
  await campaigns.schedule(c.id, { scheduledAt: new Date(Date.now() + 3600e3).toISOString(), confirm: true, expectedRecipients: 1 }, accounts.owner);
  // the "server" is down; the clock moves past the scheduled time
  await q("UPDATE newsletter_campaigns SET scheduled_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 3 HOUR) WHERE id = ?", [c.id]);
  assert.equal(sent.length, 0);
  // a "fresh process": reload the sender module so nothing is carried over in memory
  const senderPath = require.resolve(path.join(root, "services", "newsletter-sender.service"));
  delete require.cache[senderPath];
  const fresh = require(senderPath);
  const summary = await fresh.processTick({ sendMail, sender: senderInfo, config: { delayMs: 0 } });
  assert.equal(summary.started, 1);
  assert.equal(sent.length, 1);
  assert.equal(await statusOf(c.id), "sent");
});

test("recovery: a campaign interrupted half-way continues where it stopped, without re-sending", { skip: SKIP }, async () => {
  for (let i = 0; i < 4; i += 1) await sub(`r${i}@example.test`);
  const c = await makeCampaign();
  await startNow(c.id, 4);
  await tick({ config: { batchSize: 2 } }); // "crash" after two
  assert.equal(sent.length, 2);
  assert.equal(await statusOf(c.id), "sending");
  const before = sent.map((m) => m.to);
  await q("UPDATE newsletter_campaigns SET locked_by = 'dead-worker', locked_until = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 MINUTE) WHERE id = ?", [c.id]);
  await tick();
  assert.equal(sent.length, 4);
  assert.equal(new Set(sent.map((m) => m.to)).size, 4);
  assert.deepEqual(sent.slice(0, 2).map((m) => m.to), before);
  assert.equal(await statusOf(c.id), "sent");
});

test("recovery: a recipient stuck 'sending' after a crash is recorded as interrupted and NEVER re-sent (avoids duplicates)", { skip: SKIP }, async () => {
  const a = await sub("a@example.test");
  const b = await sub("b@example.test");
  const c = await makeCampaign();
  await startNow(c.id, 2);
  await tick({ config: { batchSize: 1 } });
  assert.equal(sent.length, 1);
  const stuck = (await recipientsOf(c.id)).find((r) => r.status === "queued");
  await q("UPDATE newsletter_campaign_recipients SET status = 'sending', attempts = 1, claimed_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 30 MINUTE) WHERE id = ?", [stuck.id]);
  sent.length = 0;
  const summary = await tick();
  assert.equal(summary.recovered, 1);
  assert.equal(sent.length, 0, "delivery was unknown, so it must not be repeated");
  const row = (await recipientsOf(c.id)).find((r) => r.id === stuck.id);
  assert.equal(row.status, "failed");
  assert.equal(row.error_kind, "interrupted");
  assert.equal(await statusOf(c.id), "partially_failed");
  assert.ok(a && b);
});

test("a freshly claimed recipient is not mistaken for a crash", { skip: SKIP }, async () => {
  await sub("a@example.test");
  const c = await makeCampaign();
  await startNow(c.id, 1);
  await tick({ config: { batchSize: 1 } });
  await q("UPDATE newsletter_campaign_recipients SET status = 'sending', sent_at = NULL, claimed_at = UTC_TIMESTAMP(6) WHERE campaign_id = ?", [c.id]);
  await q("UPDATE newsletter_campaigns SET status = 'sending', completed_at = NULL WHERE id = ?", [c.id]);
  assert.equal((await tick()).recovered, 0);
});

test("cancel a scheduled campaign: nothing is ever sent, the audit trail records it", { skip: SKIP }, async () => {
  await sub("a@example.test");
  const c = await makeCampaign();
  await campaigns.schedule(c.id, { scheduledAt: new Date(Date.now() + 3600e3).toISOString(), confirm: true, expectedRecipients: 1 }, accounts.owner);
  const cancelled = await campaigns.cancel(c.id, accounts.owner);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.cancelledAt);
  await q("UPDATE newsletter_campaigns SET scheduled_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 HOUR) WHERE id = ?", [c.id]);
  await tick();
  assert.equal(sent.length, 0);
  assert.equal(await statusOf(c.id), "cancelled");
  await assert.rejects(campaigns.cancel(c.id, accounts.owner), (e) => e.code === "NOT_CANCELLABLE");
  await assert.rejects(campaigns.cancel((await makeCampaign()).id, accounts.owner), (e) => e.code === "NOT_CANCELLABLE", "a draft is not cancellable");
  assert.ok((await auditActions()).some((a) => a.action === "newsletter.campaign.cancel"));
});

test("cancel while sending: the queue stops at once, the rest are skipped, in-flight mail is not recalled", { skip: SKIP }, async () => {
  for (let i = 0; i < 4; i += 1) await sub(`c${i}@example.test`);
  const c = await makeCampaign();
  await startNow(c.id, 4);
  mailBehavior = async () => { if (sent.length === 1) await campaigns.cancel(c.id, accounts.owner); };
  await tick();
  assert.equal(sent.length, 2, "the message in flight finished; nothing after it");
  assert.equal(await statusOf(c.id), "cancelled");
  const rows = await recipientsOf(c.id);
  assert.equal(rows.filter((r) => r.status === "sent").length, 2);
  const skipped = rows.filter((r) => r.status === "skipped");
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((r) => r.error_kind === "cancelled"));
  sent.length = 0;
  await tick(); await tick();
  assert.equal(sent.length, 0);
});

test("daily limit: sending pauses at the limit and resumes on the next day's tick", { skip: SKIP }, async () => {
  for (let i = 0; i < 3; i += 1) await sub(`l${i}@example.test`);
  const c = await makeCampaign();
  await startNow(c.id, 3);
  const first = await tick({ config: { dailyLimit: 2 } });
  assert.equal(sent.length, 2);
  assert.deepEqual(first.paused, [{ campaign: c.id, reason: "daily_limit" }]);
  assert.equal(await statusOf(c.id), "sending");
  await q("UPDATE newsletter_campaign_recipients SET sent_at = DATE_SUB(sent_at, INTERVAL 1 DAY) WHERE campaign_id = ?", [c.id]); // "tomorrow"
  await tick({ config: { dailyLimit: 2 } });
  assert.equal(sent.length, 3);
  assert.equal(await statusOf(c.id), "sent");
});

// =======================================================================================
// RETRIES AND FAILURES
// =======================================================================================
const smtpError = (responseCode, code = "EENVELOPE", message = "failure") => Object.assign(new Error(message), { responseCode, code });

test("temporary SMTP failure: retried later with backoff, then delivered", { skip: SKIP }, async () => {
  await sub("a@example.test");
  const c = await makeCampaign();
  await startNow(c.id, 1);
  mailBehavior = async () => { throw smtpError(421, "ECONNECTION", "Service not available, try later"); };
  await tick();
  let row = (await recipientsOf(c.id))[0];
  assert.equal(row.status, "queued");
  assert.equal(row.attempts, 1);
  assert.equal(row.error_kind, "temporary");
  assert.match(row.last_error, /ECONNECTION/);
  assert.ok(row.next_attempt_at, "a retry time is set");
  assert.equal(sent.length, 0);

  await tick(); // not yet due: nothing is retried early
  assert.equal((await recipientsOf(c.id))[0].attempts, 1);

  mailBehavior = null;
  await q("UPDATE newsletter_campaign_recipients SET next_attempt_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 MINUTE)");
  await tick();
  row = (await recipientsOf(c.id))[0];
  assert.equal(row.status, "sent");
  assert.equal(row.attempts, 2);
  assert.equal(row.last_error, null);
  assert.equal(sent.length, 1);
  assert.equal(await statusOf(c.id), "sent");
});

test("temporary failures stop after 3 attempts: the recipient fails and the campaign is 'partially failed'", { skip: SKIP }, async () => {
  await sub("a@example.test");
  await sub("b@example.test");
  const c = await makeCampaign();
  await startNow(c.id, 2);
  mailBehavior = async (mail) => { if (mail.to === "a@example.test") throw smtpError(451, "ETIMEDOUT", "Greylisted"); };
  for (let i = 0; i < 3; i += 1) {
    await tick();
    await q("UPDATE newsletter_campaign_recipients SET next_attempt_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 MINUTE) WHERE status = 'queued'");
  }
  const rows = await recipientsOf(c.id);
  const a = rows.find((r) => r.email === "a@example.test");
  assert.equal(a.status, "failed");
  assert.equal(a.attempts, 3);
  assert.match(a.last_error, /gave up after 3 attempts/);
  assert.equal(rows.find((r) => r.email === "b@example.test").status, "sent");
  assert.equal(await statusOf(c.id), "partially_failed");
  const info = await campaigns.get(c.id, accounts.owner);
  assert.equal(info.stats.failed, 1);
  assert.equal(info.stats.sent, 1);
});

test("permanent failure (5xx): recorded at once, never retried, the rest of the campaign continues", { skip: SKIP }, async () => {
  await sub("bad@example.test");
  await sub("good@example.test");
  const c = await makeCampaign();
  await startNow(c.id, 2);
  mailBehavior = async (mail) => { if (mail.to === "bad@example.test") throw smtpError(550, "EENVELOPE", "Mailbox unavailable"); };
  await tick(); await tick();
  const rows = await recipientsOf(c.id);
  const bad = rows.find((r) => r.email === "bad@example.test");
  assert.equal(bad.status, "failed");
  assert.equal(bad.error_kind, "permanent");
  assert.equal(bad.attempts, 1);
  assert.equal(rows.find((r) => r.email === "good@example.test").status, "sent");
  assert.equal(await statusOf(c.id), "partially_failed");
});

test("every recipient failing permanently marks the campaign 'failed'", { skip: SKIP }, async () => {
  await sub("a@example.test");
  const c = await makeCampaign();
  await startNow(c.id, 1);
  mailBehavior = async () => { throw smtpError(554, "EENVELOPE", "Rejected"); };
  await tick();
  assert.equal(await statusOf(c.id), "failed");
  assert.match((await campaigns.get(c.id, accounts.owner)).errorNote, /No email was delivered/);
});

test("wrong mail credentials: sending pauses, nobody loses an attempt, and recovers when fixed", { skip: SKIP }, async () => {
  await sub("a@example.test");
  await sub("b@example.test");
  const c = await makeCampaign();
  await startNow(c.id, 2);
  mailBehavior = async () => { throw Object.assign(new Error("Invalid login: 535 Authentication failed"), { code: "EAUTH", responseCode: 535 }); };
  const summary = await tick();
  assert.deepEqual(summary.paused, [{ campaign: c.id, reason: "mail_auth_failed" }]);
  const rows = await recipientsOf(c.id);
  assert.ok(rows.every((r) => r.status === "queued" && r.attempts === 0), "no attempt consumed");
  assert.equal(await statusOf(c.id), "sending");
  mailBehavior = null;
  await q("UPDATE newsletter_campaign_recipients SET next_attempt_at = NULL");
  await tick();
  assert.equal(sent.length, 2);
});

test("a run of temporary failures (mail server in trouble) stops the tick early", { skip: SKIP }, async () => {
  for (let i = 0; i < 9; i += 1) await sub(`t${i}@example.test`);
  const c = await makeCampaign();
  await startNow(c.id, 9);
  let calls = 0;
  mailBehavior = async () => { calls += 1; throw smtpError(421, "ECONNECTION", "down"); };
  const summary = await tick();
  assert.equal(calls, 5, "gave up after 5 consecutive failures instead of hammering the server");
  assert.deepEqual(summary.paused, [{ campaign: c.id, reason: "mail_server_trouble" }]);
});

test("SMTP errors are stored without secrets or the recipient address", { skip: SKIP }, async () => {
  process.env.BREVO_SMTP_KEY = "super-secret-smtp-key";
  try {
    await sub("a@example.test");
    const c = await makeCampaign();
    await startNow(c.id, 1);
    mailBehavior = async () => { throw smtpError(550, "EENVELOPE", "auth super-secret-smtp-key rejected\n\n" + "x".repeat(500)); };
    await tick();
    const row = (await recipientsOf(c.id))[0];
    assert.ok(!row.last_error.includes("super-secret-smtp-key"));
    assert.ok(row.last_error.length <= 200);
    assert.ok(!/\n/.test(row.last_error));
  } finally {
    delete process.env.BREVO_SMTP_KEY;
  }
});

test("classifyError: permanent / temporary / auth", { skip: SKIP }, () => {
  assert.equal(sender.classifyError(smtpError(550)), "permanent");
  assert.equal(sender.classifyError(smtpError(421)), "temporary");
  assert.equal(sender.classifyError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), "temporary");
  assert.equal(sender.classifyError(Object.assign(new Error("x"), { code: "EAUTH" })), "auth");
  assert.equal(sender.classifyError(new Error("mystery")), "temporary");
});

// =======================================================================================
// TEST EMAILS
// =======================================================================================
test("test email: goes only to active Admin / Super Admin accounts, is labelled, never to an outside address", { skip: SKIP }, async () => {
  await sub("a@example.test");
  const c = await makeCampaign();
  const deps = { sendMail, sender: senderInfo };
  const own = await campaigns.sendTest(c.id, {}, accounts.owner, deps);
  assert.equal(own.sent, 1);
  assert.equal(sent[0].to, "owner@example.test");
  assert.equal(sent[0].subject, "[TEST] Hello from KOVENIK");
  assert.match(sent[0].html, /test email/i);
  assert.ok(!sent[0].headers, "a test carries no real unsubscribe headers");

  sent.length = 0;
  assert.equal((await campaigns.sendTest(c.id, { to: ["admin@example.test", "OWNER@example.test"] }, accounts.owner, deps)).sent, 2);
  sent.length = 0;
  for (const to of [["stranger@example.test"], ["admin@example.test", "customer@example.test"], ["a@example.test"], ["a@x.test", "b@x.test", "c@x.test", "d@x.test"]]) {
    await assert.rejects(campaigns.sendTest(c.id, { to }, accounts.owner, deps), (e) => e.code === "TEST_RECIPIENTS_INVALID", JSON.stringify(to));
  }
  await q("UPDATE profiles SET is_active = 0 WHERE id = ?", [ids.admin]);
  await assert.rejects(campaigns.sendTest(c.id, { to: ["admin@example.test"] }, accounts.owner, deps), (e) => e.code === "TEST_RECIPIENTS_INVALID");
  assert.equal(sent.length, 0);

  mailBehavior = async () => { throw new Error("smtp down"); };
  await assert.rejects(campaigns.sendTest(c.id, {}, accounts.owner, deps), (e) => e.statusCode === 502 && e.code === "TEST_SEND_FAILED");
  // test mode never needs the PIN, but still refuses an empty subject
  mailBehavior = null;
  await assert.rejects(campaigns.sendTest((await makeCampaign({ subject: "" })).id, {}, accounts.owner, deps), (e) => e.code === "SUBJECT_REQUIRED");
});

test("test email over HTTP: Super Admin only", { skip: SKIP }, async () => {
  const c = await makeCampaign();
  assert.equal((await call("POST", `/api/admin/newsletter/campaigns/${c.id}/test`, "admin", {})).status, 403);
  // (a real HTTP test send would use the live mailer; the service-level test above covers delivery with a recorder)
});

// =======================================================================================
// PROVIDER WEBHOOK + ANALYTICS
// =======================================================================================
const WEBHOOK_SECRET = "webhook-secret-for-tests-0123456789";
const webhook = (body, secret = WEBHOOK_SECRET, via = "bearer") =>
  fetch(`${base}/api/newsletter/provider-webhook${via === "query" ? `?token=${secret}` : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(via === "bearer" && secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(body),
  });

test("webhook: refuses callers until configured, rejects wrong secrets, accepts the right one", { skip: SKIP }, async () => {
  delete process.env.BREVO_WEBHOOK_SECRET;
  assert.equal((await webhook({ event: "delivered" })).status, 503);
  process.env.BREVO_WEBHOOK_SECRET = WEBHOOK_SECRET;
  try {
    assert.equal((await webhook({ event: "delivered" }, "")).status, 401);
    assert.equal((await webhook({ event: "delivered" }, "wrong-secret-wrong-secret")).status, 401);
    assert.equal((await webhook({ event: "delivered" }, WEBHOOK_SECRET)).status, 200);
    assert.equal((await webhook({ event: "delivered" }, WEBHOOK_SECRET, "query")).status, 200);
    process.env.BREVO_WEBHOOK_SECRET = "short";
    assert.equal((await webhook({ event: "delivered" }, "short")).status, 503, "a weak secret is treated as not configured");
  } finally {
    delete process.env.BREVO_WEBHOOK_SECRET;
  }
});

test("webhook + analytics: delivered / bounced / complaint are real, opens and clicks are ignored, repeats are harmless", { skip: SKIP }, async () => {
  process.env.BREVO_WEBHOOK_SECRET = WEBHOOK_SECRET;
  try {
    const a = await sub("a@example.test");
    const b = await sub("b@example.test");
    const d = await sub("d@example.test");
    const e = await sub("e@example.test");
    const c = await makeCampaign();
    await startNow(c.id, 4);
    await tick();
    assert.equal(sent.length, 4);

    // before any provider data: nothing is invented
    let stats = (await campaigns.get(c.id, accounts.owner)).stats;
    assert.equal(stats.sent, 4);
    assert.equal(stats.delivered, null);
    assert.equal(stats.bounced, null);
    assert.equal(stats.deliveryRate, null);
    assert.equal(stats.bounceRate, null);
    assert.equal(stats.providerData, false);
    assert.equal(stats.acceptanceRate, 100);
    assert.ok(!("opened" in stats) && !("clicked" in stats) && !("openRate" in stats), "no open / click statistics");

    const tag = `kv-c${c.id}`;
    const res = await webhook([
      { event: "delivered", email: "a@example.test", tag, ts_event: 1763300000 },
      { event: "delivered", email: "B@Example.test", tag, ts_event: 1763300001 },
      { event: "hard_bounce", email: "d@example.test", tag, ts_event: 1763300002 },
      { event: "spam", email: "e@example.test", tag, ts_event: 1763300003 },
      { event: "opened", email: "a@example.test", tag, ts_event: 1763300004 },
      { event: "click", email: "a@example.test", tag, ts_event: 1763300005 },
      { event: "delivered", email: "a@example.test", tag: "someone-elses-tag", ts_event: 1763300006 },
      { event: "delivered", email: "nobody@example.test", tag },
    ]);
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.received, 8);
    assert.equal(out.applied, 4);
    assert.equal(out.ignored, 4);

    // the same notifications again change nothing
    assert.equal((await (await webhook([{ event: "delivered", email: "a@example.test", tag, ts_event: 1763300000 }])).json()).duplicate, 1);

    stats = (await campaigns.get(c.id, accounts.owner)).stats;
    assert.equal(stats.providerData, true);
    assert.equal(stats.delivered, 2);
    assert.equal(stats.bounced, 1);
    assert.equal(stats.complaints, 1);
    assert.equal(stats.deliveryRate, 50);
    assert.equal(stats.bounceRate, 25);

    // bounced and complaining addresses are suppressed from every future send
    assert.equal(await subStatus(d), "bounced");
    assert.equal(await subStatus(e), "complained");
    assert.equal(await subStatus(a), "active");
    assert.deepEqual((await newsletter.listSendable({})).map((r) => r.id).sort(), [a, b].sort());
    // ...and a bounced address cannot be re-activated by a stale confirmation flow
    assert.equal(await newsletter.countSendable({}), 2);

    const events = await q("SELECT event, COUNT(*) c FROM newsletter_events GROUP BY event");
    assert.deepEqual(Object.fromEntries(events.map((r) => [r.event, Number(r.c)])), { delivered: 2, bounced: 1, complaint: 1 });
    const stored = JSON.stringify(await q("SELECT * FROM newsletter_events"));
    assert.ok(!stored.includes("@example.test"), "no e-mail addresses in the events table");
  } finally {
    delete process.env.BREVO_WEBHOOK_SECRET;
  }
});

test("analytics: unsubscribe count is attributed to the campaign whose e-mail was used; rates and completion time", { skip: SKIP }, async () => {
  const a = await sub("a@example.test");
  await sub("b@example.test");
  await sub("c@example.test");
  await sub("d@example.test");
  const c = await makeCampaign();
  await startNow(c.id, 4);
  await tick();
  const token = /token=([A-Za-z0-9_-]{43})"/.exec(sent.find((m) => m.to === "a@example.test").html)[1];
  await newsletter.unsubscribe(token);
  const info = await campaigns.get(c.id, accounts.admin);
  assert.equal(info.stats.queued, 4);
  assert.equal(info.stats.sent, 4);
  assert.equal(info.stats.unsubscribed, 1);
  assert.equal(info.stats.unsubscribeRate, 25);
  assert.equal(info.stats.failed, 0);
  assert.ok(info.stats.completionSeconds >= 0);

  // another campaign is not credited with this unsubscribe
  const other = await makeCampaign({ name: "Other" });
  assert.equal((await campaigns.get(other.id, accounts.admin)).stats.unsubscribed, 0);
  assert.equal(await subStatus(a), "unsubscribed");
});

test("overview dashboard: real counts for subscribers, campaigns by status, email totals, chart and recent activity", { skip: SKIP }, async () => {
  await sub("a@example.test");
  await sub("b@example.test");
  await sub("p@example.test", "pending");
  const draft = await makeCampaign({ name: "Draft one" });
  const done = await makeCampaign({ name: "Done one" });
  await startNow(done.id, 2);
  await tick();
  const sched = await makeCampaign({ name: "Sched one" });
  await campaigns.schedule(sched.id, { scheduledAt: new Date(Date.now() + 3600e3).toISOString(), confirm: true, expectedRecipients: 2 }, accounts.owner);

  const o = await campaigns.overview();
  assert.deepEqual(o.subscribers, { total: 3, active: 2 });
  assert.equal(o.campaigns.total, 3);
  assert.equal(o.campaigns.draft, 1);
  assert.equal(o.campaigns.scheduled, 1);
  assert.equal(o.campaigns.sent, 1);
  assert.equal(o.emails.sent, 2);
  assert.equal(o.emails.failed, 0);
  assert.equal(o.emails.delivered, null);
  assert.equal(o.rates.acceptance, 100);
  assert.equal(o.rates.delivery, null);
  assert.equal(o.providerData, false);
  assert.deepEqual(o.performance.map((p) => p.name), ["Done one"]);
  assert.equal(o.performance[0].sent, 2);
  assert.deepEqual(o.recent.map((r) => r.name), ["Sched one", "Done one", "Draft one"]);
  assert.ok(draft.id);

  const http = await (await call("GET", "/api/admin/newsletter/overview", "admin")).json();
  assert.equal(http.overview.campaigns.total, 3);
  assert.ok(!JSON.stringify(http).includes("@example.test"), "the dashboard never exposes addresses");
});

test("recipient report and CSV: Super Admin only, formula-injection safe, audited", { skip: SKIP }, async () => {
  await sub("+SUM(1+1)@example.test");
  await sub("normal@example.test");
  const c = await makeCampaign();
  await startNow(c.id, 2);
  await tick();

  const page = await (await call("GET", `/api/admin/newsletter/campaigns/${c.id}/recipients?limit=1&page=2`, "owner")).json();
  assert.equal(page.pagination.total, 2);
  assert.equal(page.recipients.length, 1);
  assert.equal((await call("GET", `/api/admin/newsletter/campaigns/${c.id}/recipients?status=bogus`, "owner")).status, 400);
  assert.equal((await (await call("GET", `/api/admin/newsletter/campaigns/${c.id}/recipients?status=sent`, "owner")).json()).pagination.total, 2);

  const res = await call("GET", `/api/admin/newsletter/campaigns/${c.id}/report.csv`, "owner");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), new RegExp(`kovenik-campaign-${c.id}-report\\.csv`));
  const lines = (await res.text()).replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines[0], "email,status,attempts,sent_at_utc,delivered_at_utc,bounced_at_utc,error");
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l.startsWith("'+SUM(1+1)@example.test,")), "a leading + is neutralised");
  assert.ok(!lines.some((l) => /^[=+\-@]/.test(l)));
  assert.ok(await eventually(async () => (await auditActions()).some((a) => a.action === "export.newsletter_campaign")), "export is audited");
  assert.equal((await call("GET", `/api/admin/newsletter/campaigns/${c.id}/report.csv`, "admin")).status, 403);
  assert.equal((await call("GET", "/api/admin/newsletter/campaigns/999999/report.csv", "owner")).status, 404);
});

// =======================================================================================
// WORKER ENDPOINT
// =======================================================================================
test("worker tick endpoint: secret protected, processes due campaigns for an external scheduler", { skip: SKIP }, async () => {
  const hit = (secret) => fetch(`${base}/api/newsletter/worker/tick`, { method: "POST", headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
  delete process.env.NEWSLETTER_WORKER_SECRET;
  assert.equal((await hit("anything-at-all-anything")).status, 503);
  process.env.NEWSLETTER_WORKER_SECRET = "worker-secret-for-tests-0123456789";
  try {
    assert.equal((await hit()).status, 401);
    assert.equal((await hit("wrong-wrong-wrong-wrong-wrong")).status, 401);
    const ok = await hit("worker-secret-for-tests-0123456789");
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.success, true);
    assert.ok("tick" in body);
  } finally {
    delete process.env.NEWSLETTER_WORKER_SECRET;
  }
});

// =======================================================================================
// AUDIT LOGGING
// =======================================================================================
test("audit log: every campaign action is recorded with the actor's role, and never holds a subscriber address", { skip: SKIP }, async () => {
  const a = await sub("private.person@example.test");
  await campaigns.saveTemplate(undefined, { name: "T", design: DESIGN }, accounts.admin);
  const c = await makeCampaign({}, "admin");
  await campaigns.update(c.id, { name: "Edited" }, accounts.admin);
  await campaigns.update(c.id, { audienceType: "selected", audienceIds: [a] }, accounts.owner);
  await campaigns.duplicate(c.id, accounts.admin);
  await campaigns.sendTest(c.id, {}, accounts.owner, { sendMail, sender: senderInfo });
  const s = await makeCampaign({ name: "S" });
  await campaigns.schedule(s.id, { scheduledAt: new Date(Date.now() + 3600e3).toISOString(), confirm: true, expectedRecipients: 1 }, accounts.owner);
  await campaigns.cancel(s.id, accounts.owner);
  const sendIt = await makeCampaign({ name: "Send" });
  await startNow(sendIt.id, 1);

  const log = await auditActions();
  const seen = new Set(log.map((r) => r.action));
  for (const action of [
    "newsletter.template.create", "newsletter.campaign.create", "newsletter.campaign.update", "newsletter.campaign.duplicate",
    "newsletter.campaign.test_send", "newsletter.campaign.schedule", "newsletter.campaign.cancel", "newsletter.campaign.send",
  ]) assert.ok(seen.has(action), `missing audit entry: ${action}`);
  assert.equal(log.find((r) => r.action === "newsletter.campaign.create").actor_role, "admin");
  assert.equal(log.find((r) => r.action === "newsletter.campaign.send").actor_role, "superadmin");
  assert.ok(!JSON.stringify(log).includes("private.person"), "no subscriber address in the audit trail");
});

test("campaign tables missing -> an honest 503 rather than a crash", { skip: SKIP }, async () => {
  await pool.query("RENAME TABLE newsletter_campaigns TO newsletter_campaigns_off");
  try {
    const res = await call("GET", "/api/admin/newsletter/campaigns", "admin");
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "CAMPAIGNS_NOT_AVAILABLE");
    assert.equal((await call("GET", "/api/admin/newsletter/overview", "admin")).status, 503);
    assert.deepEqual(await tick(), { skipped: "not_available" });
  } finally {
    await pool.query("RENAME TABLE newsletter_campaigns_off TO newsletter_campaigns");
  }
});
