// Newsletter phase 1: validation, double opt-in, hashed single-use expiring tokens, throttling,
// honest failures, HTTP route + rate limits. Real service code against an in-memory stand-in for
// MySQL and a stubbed mailer: nothing touches a database or sends an e-mail.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const crypto = require("crypto");

process.env.JWT_SECRET = "test-secret-not-used-anywhere-else";
delete process.env.CORS_ORIGINS;

const root = path.join(__dirname, "..");
const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

// ---- in-memory database -------------------------------------------------------------
let now = Date.now();
let subs = [];
let tokens = [];
let missingTables = false;
const HOUR = 3600 * 1000;

const reset = () => {
  now = Date.now();
  subs = [];
  tokens = [];
  missingTables = false;
};

const pool = {
  async execute(sql, p = []) {
    if (missingTables) {
      const error = new Error("Table doesn't exist");
      error.code = "ER_NO_SUCH_TABLE";
      throw error;
    }
    const t = norm(sql);

    if (t.startsWith("select id, status from newsletter_subscribers where email = ?")) {
      return [subs.filter((s) => s.email === p[0]).map((s) => ({ id: s.id, status: s.status }))];
    }
    if (t.startsWith("insert ignore into newsletter_subscribers")) {
      if (subs.some((s) => s.email === p[0])) return [{ affectedRows: 0 }];
      subs.push({
        id: subs.length + 1, email: p[0], status: "pending", source: p[1], consentVersion: p[2],
        ipHash: p[3], userAgent: p[4], confirmationSentAt: null, confirmedAt: null,
      });
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("update newsletter_subscribers set confirmation_sent_at = utc_timestamp(6)")) {
      const s = subs.find((x) => x.id === p[0]);
      const ok = s && s.status !== "active" && (s.confirmationSentAt === null || s.confirmationSentAt < now - HOUR);
      if (ok) s.confirmationSentAt = now;
      return [{ affectedRows: ok ? 1 : 0 }];
    }
    if (t.startsWith("update newsletter_subscribers set confirmation_sent_at = null")) {
      const s = subs.find((x) => x.id === p[0]);
      if (s) s.confirmationSentAt = null;
      return [{ affectedRows: s ? 1 : 0 }];
    }
    if (t.startsWith("update newsletter_tokens set used_at = utc_timestamp(6) where subscriber_id = ?")) {
      let n = 0;
      for (const k of tokens) if (k.subscriberId === p[0] && k.purpose === "confirm" && !k.usedAt) { k.usedAt = now; n += 1; }
      return [{ affectedRows: n }];
    }
    if (t.startsWith("update newsletter_tokens set used_at = utc_timestamp(6) where token_hash = ?")) {
      const k = tokens.find((x) => x.hash === p[0]);
      if (k) k.usedAt = now;
      return [{ affectedRows: k ? 1 : 0 }];
    }
    if (t.startsWith("insert into newsletter_tokens")) {
      tokens.push({ subscriberId: p[0], purpose: "confirm", hash: p[1], expiresAt: now + 48 * HOUR, usedAt: null });
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("update newsletter_tokens t join newsletter_subscribers s")) {
      const k = tokens.find((x) => x.hash === p[0] && x.purpose === "confirm" && !x.usedAt && x.expiresAt > now);
      const s = k && subs.find((x) => x.id === k.subscriberId && ["pending", "unsubscribed"].includes(x.status));
      if (!s) return [{ affectedRows: 0 }];
      k.usedAt = now;
      s.status = "active";
      s.confirmedAt = now;
      return [{ affectedRows: 2 }];
    }
    if (t.startsWith("select t.used_at")) {
      const k = tokens.find((x) => x.hash === p[0] && x.purpose === "confirm");
      if (!k) return [[]];
      const s = subs.find((x) => x.id === k.subscriberId);
      return [[{ used_at: k.usedAt, expired: k.expiresAt <= now ? 1 : 0, status: s.status }]];
    }
    throw new Error("Unexpected SQL in test: " + t);
  },
};

require.cache[require.resolve(path.join(root, "config/sql"))] = {
  id: "sql", filename: "sql", loaded: true, exports: { poolPromise: Promise.resolve(pool) },
};
const sent = [];
let mailDown = false;
require.cache[require.resolve(path.join(root, "config/mailer"))] = {
  id: "mailer", filename: "mailer", loaded: true,
  exports: {
    transporter: { sendMail: async (m) => { if (mailDown) throw new Error("smtp down"); sent.push(m); } },
    getBrevoSender: () => ({ from: { name: "KOVENIK", address: "noreply@example.test" }, envelopeFrom: "noreply@example.test" }),
  },
};

const newsletter = require(path.join(root, "services/newsletter.service"));

const outbox = [];
const deliver = async (mail) => { if (mailDown) throw new Error("smtp down"); outbox.push(mail); };
const tokenFrom = (url) => new URL(url).searchParams.get("token");
const ctx = { ip: "203.0.113.9", userAgent: "TestAgent/1.0" };

test.beforeEach(() => { reset(); outbox.length = 0; sent.length = 0; mailDown = false; });

// ---- validation -----------------------------------------------------------------------
test("normalizeEmail accepts real addresses and rejects junk", () => {
  assert.equal(newsletter.normalizeEmail("  Asha.Rao+kv@Example.COM "), "asha.rao+kv@example.com");
  for (const bad of ["", "nope", "a@b", "a@@b.com", "a b@c.com", ".a@b.com", "a..b@c.com", "a@-b.com", "a@b..com",
    "x@y.z", "a\r\nBcc: v@x.com@e.com", "<script>@e.com", 42, null, undefined, {}, "a".repeat(65) + "@e.com", "a@" + "b".repeat(250) + ".com"]) {
    assert.equal(newsletter.normalizeEmail(bad), "", `should reject ${String(bad).slice(0, 30)}`);
  }
});

test("an invalid email is a 400 and nothing is stored or sent", async () => {
  await assert.rejects(newsletter.subscribe({ email: "nope" }, ctx, { pool, deliver }), (e) => e.statusCode === 400 && e.code === "EMAIL_INVALID");
  assert.equal(subs.length, 0);
  assert.equal(outbox.length, 0);
});

// ---- subscribe ------------------------------------------------------------------------
test("a new sign-up is PENDING (not active) and gets a confirmation e-mail", async () => {
  const result = await newsletter.subscribe({ email: "Asha@Example.com", source: "home" }, ctx, { pool, deliver });
  assert.match(result.message, /confirmation/i);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].email, "asha@example.com");
  assert.equal(subs[0].status, "pending");
  assert.equal(subs[0].consentVersion, newsletter.CONSENT_TEXT_VERSION);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].template, "newsletter_confirm");
  assert.equal(outbox[0].to, "asha@example.com");
});

test("consent keeps a keyed hash of the IP, never the IP itself", async () => {
  await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  assert.match(subs[0].ipHash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(subs[0]).includes("203.0.113.9"));
  assert.equal(subs[0].ipHash, crypto.createHmac("sha256", process.env.JWT_SECRET).update("203.0.113.9").digest("hex"));
});

test("only the SHA-256 hash of the token is stored", async () => {
  await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  const token = tokenFrom(outbox[0].data.confirmUrl);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/); // 256 bits
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].hash, crypto.createHash("sha256").update(token).digest("hex"));
  assert.ok(!JSON.stringify(tokens).includes(token));
});

test("tokens are unique and unpredictable", async () => {
  await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  await newsletter.subscribe({ email: "b@example.com" }, ctx, { pool, deliver });
  assert.notEqual(tokenFrom(outbox[0].data.confirmUrl), tokenFrom(outbox[1].data.confirmUrl));
});

test("a duplicate sign-up creates no second row and, within the hour, no second e-mail", async () => {
  const first = await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  const second = await newsletter.subscribe({ email: "A@Example.com" }, ctx, { pool, deliver });
  assert.equal(subs.length, 1);
  assert.equal(outbox.length, 1);
  assert.equal(second.message, first.message); // same answer: no way to probe the list
});

test("after an hour a pending address may get a fresh link, and the old one dies", async () => {
  await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  const oldToken = tokenFrom(outbox[0].data.confirmUrl);
  now += 2 * HOUR;
  await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  assert.equal(outbox.length, 2);
  await assert.rejects(newsletter.confirm(oldToken, { pool }), (e) => e.statusCode === 400);
  assert.equal(subs[0].status, "pending");
  await newsletter.confirm(tokenFrom(outbox[1].data.confirmUrl), { pool });
  assert.equal(subs[0].status, "active");
});

test("an already-active address gets the same answer and no e-mail", async () => {
  await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  await newsletter.confirm(tokenFrom(outbox[0].data.confirmUrl), { pool });
  now += 5 * HOUR;
  const again = await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  assert.match(again.message, /confirmation/i);
  assert.equal(outbox.length, 1);
  assert.equal(subs[0].status, "active");
});

test("an unsubscribed address stays suppressed until it confirms again", async () => {
  await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  await newsletter.confirm(tokenFrom(outbox[0].data.confirmUrl), { pool });
  subs[0].status = "unsubscribed";
  now += 5 * HOUR;
  await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  assert.equal(subs[0].status, "unsubscribed"); // not re-activated by merely typing the address
  assert.equal(outbox.length, 2);
  await newsletter.confirm(tokenFrom(outbox[1].data.confirmUrl), { pool });
  assert.equal(subs[0].status, "active");
});

test("a failed confirmation e-mail is a 503, kills the link, and allows an immediate retry", async () => {
  mailDown = true;
  await assert.rejects(newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver }), (e) => e.statusCode === 503 && e.code === "EMAIL_SEND_FAILED");
  assert.ok(tokens.every((k) => k.usedAt), "undelivered link must be dead");
  assert.equal(subs[0].confirmationSentAt, null);
  mailDown = false;
  await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  assert.equal(outbox.length, 1);
});

test("tables not migrated yet -> honest 503, no crash", async () => {
  missingTables = true;
  await assert.rejects(newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver }), (e) => e.statusCode === 503 && e.code === "NEWSLETTER_NOT_AVAILABLE");
  await assert.rejects(newsletter.confirm("A".repeat(43), { pool }), (e) => e.statusCode === 503);
});

// ---- confirm --------------------------------------------------------------------------
test("a valid link activates the subscriber exactly once", async () => {
  await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  const token = tokenFrom(outbox[0].data.confirmUrl);
  const ok = await newsletter.confirm(token, { pool });
  assert.match(ok.message, /confirmed/i);
  assert.equal(subs[0].status, "active");
  assert.ok(subs[0].confirmedAt);
  // Second use: harmless, and reported as already confirmed (not as a fresh activation).
  const again = await newsletter.confirm(token, { pool });
  assert.equal(again.alreadyConfirmed, true);
});

test("an expired link is refused and the subscriber stays pending", async () => {
  await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  now += 49 * HOUR;
  await assert.rejects(newsletter.confirm(tokenFrom(outbox[0].data.confirmUrl), { pool }), (e) => e.statusCode === 410 && e.code === "TOKEN_EXPIRED");
  assert.equal(subs[0].status, "pending");
});

test("a spent link cannot revive an address that was unsubscribed afterwards", async () => {
  await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  const token = tokenFrom(outbox[0].data.confirmUrl);
  await newsletter.confirm(token, { pool });
  subs[0].status = "unsubscribed";
  await assert.rejects(newsletter.confirm(token, { pool }), (e) => e.statusCode === 400 && e.code === "TOKEN_INVALID");
  assert.equal(subs[0].status, "unsubscribed");
});

test("malformed, unknown and tampered tokens are rejected the same way", async () => {
  await newsletter.subscribe({ email: "a@example.com" }, ctx, { pool, deliver });
  const token = tokenFrom(outbox[0].data.confirmUrl);
  const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  for (const bad of [undefined, null, 5, "", "short", "A".repeat(43), tampered, token + "x", "'; DROP TABLE x;--" + "A".repeat(30)]) {
    await assert.rejects(newsletter.confirm(bad, { pool }), (e) => e.statusCode === 400 && e.code === "TOKEN_INVALID");
  }
  assert.equal(subs[0].status, "pending");
});

// ---- e-mail template ------------------------------------------------------------------
test("the confirmation e-mail is branded, honest and has no offer or coupon", () => {
  const { TEMPLATES } = require(path.join(root, "services/email/templates"));
  const mail = TEMPLATES.newsletter_confirm({ confirmUrl: "https://example.test/newsletter/confirm?token=abc", hours: 48 });
  assert.match(mail.subject, /confirm/i);
  assert.match(mail.html, /KOVENIK/);
  assert.match(mail.html, /Confirm my email/);
  assert.ok(mail.text.includes("https://example.test/newsletter/confirm?token=abc"));
  assert.doesNotMatch(mail.html + mail.text, /coupon|discount|% off|welcome to/i);
});

// ---- HTTP -----------------------------------------------------------------------------
test("HTTP: validation 400, honeypot silent, confirm flow, rate limits 429", async () => {
  const app = require(path.join(root, "app"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/newsletter`;
  const post = (route, body) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/subscribe", { email: "x" })).status, 400);

    assert.equal((await post("/subscribe", { email: "bot@example.com", website: "http://spam" })).status, 200);
    assert.equal(subs.length, 0);
    assert.equal(sent.length, 0);

    const ok = await post("/subscribe", { email: "real@example.com" });
    assert.equal(ok.status, 200);
    assert.equal(subs[0].status, "pending");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "real@example.com");
    const href = sent[0].html.match(/href="([^"]*newsletter\/confirm[^"]*)"/)[1].replace(/&amp;/g, "&");
    const token = new URL(href).searchParams.get("token");

    assert.equal((await post("/confirm", { token: "nope" })).status, 400);
    assert.equal((await post("/confirm", {})).status, 400);
    const confirmed = await post("/confirm", { token });
    assert.equal(confirmed.status, 200);
    assert.equal(subs[0].status, "active");
    // GET must not confirm (mail scanners pre-fetch links).
    assert.equal((await fetch(`${base}/confirm?token=${token}`)).status, 404);

    // Per-address limit: 3 per hour (the first request above already counted for real@).
    let limited = false;
    for (let i = 0; i < 4; i += 1) if ((await post("/subscribe", { email: "real@example.com" })).status === 429) limited = true;
    assert.ok(limited, "per-address limit");
  } finally {
    server.close();
  }
});
