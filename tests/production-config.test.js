const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Production configuration: e-mail sender brand, CORS allow-list and the Razorpay
// webhook signature check. Drives the REAL app over HTTP; the database is a stub
// (none of these requests need it) and nothing is ever sent or paid.

const LIVE_SITE = "https://ardenby.vercel.app";

process.env.NODE_ENV = "production";
process.env.CORS_ORIGINS = ` ${LIVE_SITE}/ , `; // spaces and a trailing slash are tolerated
process.env.RAZORPAY_KEY_ID = "rzp_test_unit";
process.env.RAZORPAY_KEY_SECRET = "unit_secret";
process.env.JWT_SECRET = "test-secret-not-used-anywhere-else";
process.env.BREVO_FROM_EMAIL = "shop@example.test";
delete process.env.RAZORPAY_WEBHOOK_SECRET;

const root = path.join(__dirname, "..");
const sqlPath = require.resolve(path.join(root, "config", "sql.js"));
const emptyPool = {
  execute: async () => [[]],
  query: async () => [[]],
  getConnection: async () => ({ execute: async () => [[]], release() {} }),
};
require.cache[sqlPath] = {
  id: sqlPath,
  filename: sqlPath,
  loaded: true,
  exports: { poolPromise: Promise.resolve(emptyPool), testDatabaseConnection: async () => {} },
};

const mailer = require(path.join(root, "config", "mailer.js"));
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

// ---------------------------------------------------------------- sender ----

test("e-mail sender is KOVENIK and no e-mail template still says ARDENBY", async () => {
  assert.equal(mailer.getBrevoSender().from.name, "KOVENIK");

  const sent = [];
  mailer.transporter.sendMail = async (message) => {
    sent.push(message);
    return {};
  };
  await require(path.join(root, "utils", "welcomeEmail.js"))({ email: "x@example.test", name: "Asha Rao" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from.name, "KOVENIK");
  assert.match(sent[0].subject, /KOVENIK/);
  // Case-sensitive on purpose: the live website address (ardenby.vercel.app) is a
  // link in the e-mail and is correct; only the visible brand name must be KOVENIK.
  assert.doesNotMatch(sent[0].subject + sent[0].html, /ARDENBY/);

  // Every file that builds customer or admin e-mail.
  for (const file of [
    "config/mailer.js",
    "services/auth.service.js",
    "utils/welcomeEmail.js",
    "services/notification.service.js",
    "services/admin-confirmation.service.js",
  ]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /ARDENBY/, `${file} still says ARDENBY`);
  }
});

// ------------------------------------------------------------------ CORS ----

const call = (pathname, { origin, method = "GET", headers = {}, body } = {}) =>
  fetch(base + pathname, {
    method,
    headers: { ...(origin ? { Origin: origin } : {}), ...headers },
    body,
  });

test("CORS: the live website is allowed (also with a trailing slash in the setting)", async () => {
  const res = await call("/api/nothing-here", { origin: LIVE_SITE });
  assert.equal(res.headers.get("access-control-allow-origin"), LIVE_SITE);
});

test("CORS: a preflight from the live website for a logged-in admin request is allowed", async () => {
  const res = await call("/api/admin/analytics", {
    origin: LIVE_SITE,
    method: "OPTIONS",
    headers: {
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), LIVE_SITE);
  assert.match(String(res.headers.get("access-control-allow-headers")).toLowerCase(), /authorization/);
});

test("CORS: other websites and localhost get no permission in production", async () => {
  for (const origin of ["https://evil.example", "https://ardenby.vercel.app.evil.example", "http://ardenby.vercel.app", "http://localhost:3000", "https://kovenik.in"]) {
    const res = await call("/api/nothing-here", { origin });
    assert.equal(res.headers.get("access-control-allow-origin"), null, origin);
  }
});

test("CORS: server-to-server calls without an Origin (Next.js server, Razorpay, curl) still work", async () => {
  const res = await call("/api/nothing-here");
  assert.equal(res.status, 404); // reaches the API; CORS did not block it
  assert.equal((await res.json()).message, "Not found.");
});

test("CORS: several origins can be listed (e.g. when the custom domain is connected)", async () => {
  const security = require(path.join(root, "middleware", "security.middleware.js"));
  const saved = process.env.CORS_ORIGINS;
  process.env.CORS_ORIGINS = `${LIVE_SITE},https://kovenik.in,https://www.kovenik.in/`;
  const options = security.corsOptions();
  const decide = (origin) => new Promise((resolve) => options.origin(origin, (_error, ok) => resolve(ok)));
  assert.equal(await decide(LIVE_SITE), true);
  assert.equal(await decide("https://kovenik.in"), true);
  assert.equal(await decide("https://www.kovenik.in"), true);
  assert.equal(await decide("https://evil.example"), false);
  process.env.CORS_ORIGINS = saved;
});

// --------------------------------------------------------------- webhook ----

const WEBHOOK = "/api/payments/razorpay/webhook";
const sign = (body, secret) => crypto.createHmac("sha256", secret).update(body).digest("hex");
const post = (body, signature) =>
  call(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signature ? { "X-Razorpay-Signature": signature } : {}) },
    body,
  });

test("webhook: without RAZORPAY_WEBHOOK_SECRET it says so (503) and does nothing", async () => {
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  const body = JSON.stringify({ event: "payment.authorized" });
  const res = await post(body, sign(body, "anything"));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).message, "Webhook is not configured.");
});

test("webhook: missing, wrong and body-tampered signatures are rejected (400)", async () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_unit_test_secret";
  const body = JSON.stringify({ event: "payment.authorized" });

  assert.equal((await post(body)).status, 400);
  assert.equal((await post(body, sign(body, "the-wrong-secret"))).status, 400);
  assert.equal((await post(body, "not-hex")).status, 400);
  assert.equal((await post(body + " ", sign(body, "whsec_unit_test_secret"))).status, 400);
});

test("webhook: a correctly signed event is accepted; events that change nothing here are just acknowledged", async () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_unit_test_secret";
  const body = JSON.stringify({ event: "payment.authorized", payload: {} });
  const res = await post(body, sign(body, "whsec_unit_test_secret"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, ignored: "payment.authorized" });
});
