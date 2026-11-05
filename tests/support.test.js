// Contact form backend: validation, recipient rules, honest failures, HTTP route.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

process.env.JWT_SECRET = "test-secret-not-used-anywhere-else";
delete process.env.CORS_ORIGINS;
delete process.env.SUPPORT_INBOX_EMAIL;

const root = path.join(__dirname, "..");
// Never touch a real database or SMTP relay.
require.cache[require.resolve(path.join(root, "config/sql"))] = {
  id: "sql", filename: "sql", loaded: true,
  exports: { poolPromise: Promise.resolve({ execute: async () => [[]] }) },
};
const sent = [];
require.cache[require.resolve(path.join(root, "config/mailer"))] = {
  id: "mailer", filename: "mailer", loaded: true,
  exports: {
    transporter: { sendMail: async (m) => { sent.push(m); } },
    getBrevoSender: () => ({ from: { name: "KOVENIK", address: "noreply@example.test" }, envelopeFrom: "noreply@example.test" }),
  },
};

const support = require(path.join(root, "services/support.service"));

const good = { name: "Asha", email: "Asha@Example.com", orderNumber: "KV-1001", subject: "Where is my order", message: "Hello, my order has not moved." };
const deps = (over = {}) => ({ getRecipient: async () => "inbox@example.test", sendMail: async (m) => { sent.push(m); }, ...over });

test("validate cleans fields and rejects bad input", () => {
  assert.equal(support.validate(good).email, "asha@example.com");
  const bad = (patch, code) => assert.throws(() => support.validate({ ...good, ...patch }), (e) => e.statusCode === 400 && e.code === code);
  bad({ name: "  " }, "NAME_REQUIRED");
  bad({ email: "nope" }, "EMAIL_INVALID");
  bad({ subject: "" }, "SUBJECT_REQUIRED");
  bad({ message: "short" }, "MESSAGE_SHORT");
  bad({ orderNumber: "<script>" }, "ORDER_INVALID");
  assert.equal(support.validate({ ...good, orderNumber: "" }).orderNumber, "");
});

test("a valid message is e-mailed to the configured inbox with Reply-To", async () => {
  sent.length = 0;
  await support.submit(good, deps());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "inbox@example.test");
  assert.equal(sent[0].replyTo.address, "asha@example.com");
  assert.match(sent[0].subject, /Where is my order/);
});

test("html in the message is escaped", async () => {
  sent.length = 0;
  await support.submit({ ...good, message: "<img src=x onerror=alert(1)> please help" }, deps());
  assert.ok(!sent[0].html.includes("<img"));
});

test("no support inbox configured -> 503, nothing sent", async () => {
  sent.length = 0;
  await assert.rejects(support.submit(good, deps({ getRecipient: async () => null })), (e) => e.statusCode === 503 && e.code === "SUPPORT_NOT_CONFIGURED");
  assert.equal(sent.length, 0);
});

test("a mail failure is reported as 502, not success", async () => {
  await assert.rejects(support.submit(good, deps({ sendMail: async () => { throw new Error("smtp down"); } })), (e) => e.statusCode === 502);
});

test("HTTP: validation 400, unconfigured 503, honeypot silent, rate limit 429", async () => {
  const app = require(path.join(root, "app"));
  delete process.env.SUPPORT_INBOX_EMAIL; // app.js loads .env, which now defines the local inbox
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/support`;
  const post = (body) => fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ ...good, email: "x" })).status, 400);
    sent.length = 0;
    assert.equal((await post({ ...good, website: "http://spam" })).status, 201);
    assert.equal(sent.length, 0);
    assert.equal((await post(good)).status, 503); // no inbox configured in this run
    process.env.SUPPORT_INBOX_EMAIL = "inbox@example.test";
    const ok = await post(good);
    assert.equal(ok.status, 201);
    assert.equal(sent.length, 1);
    let limited = false;
    for (let i = 0; i < 6; i += 1) if ((await post(good)).status === 429) limited = true;
    assert.ok(limited);
  } finally {
    delete process.env.SUPPORT_INBOX_EMAIL;
    server.close();
  }
});
