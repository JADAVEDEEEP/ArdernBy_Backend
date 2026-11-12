const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// New e-mail triggers (shipped, delivered, payment failed, membership reminders): each sends
// the right template once, repeats send nothing, and the sender is KOVENIK. Real notification
// code against an in-memory stand-in for MySQL and a stubbed mailer (nothing is sent).

const root = path.join(__dirname, "..");
const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

const orders = [];
const profiles = [{ id: "u1", email: "asha@example.test", full_name: "Asha Rao" }, { id: "u2", email: "ravi@example.test", full_name: "Ravi K" }];
const subs = [];
const log = new Map();

const pool = {
  async execute(sql, p = []) {
    const t = norm(sql);
    if (t.startsWith("select id, user_id, order_number, status from orders")) return [orders.filter((o) => o.id === p[0])];
    if (t.startsWith("select id, user_id, order_number, total_amount, payment_status from orders")) return [orders.filter((o) => o.id === p[0])];
    if (t.startsWith("select email, full_name from profiles")) return [profiles.filter((x) => x.id === p[0])];
    if (t.startsWith("insert ignore into notification_log")) {
      if (log.has(p[0])) return [{ affectedRows: 0 }];
      log.set(p[0], { status: "sending" });
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("update notification_log set status = 'sending'")) return [{ affectedRows: 0 }];
    if (t.startsWith("update notification_log set status = 'sent'")) {
      log.get(p[0]).status = "sent";
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("update notification_log set status = 'failed'")) return [{ affectedRows: 1 }];
    if (t.startsWith("select id, user_id, end_date from subscriptions where status = 'active'")) {
      return [subs.filter((s) => s.status === "active" && s.end_date > p[0] && s.end_date <= p[1])];
    }
    if (t.startsWith("select id, user_id, end_date from subscriptions where status = 'expired'")) {
      return [subs.filter((s) => s.status === "expired" && s.end_date <= p[0] && s.end_date > p[1])];
    }
    if (t.startsWith("select id from subscriptions where user_id = ? and status = 'active'")) {
      return [subs.filter((s) => s.user_id === p[0] && s.status === "active" && s.end_date > p[1] && s.id !== p[2])];
    }
    throw new Error(`unhandled SQL: ${t}`);
  },
};

const sqlPath = require.resolve(path.join(root, "config", "sql.js"));
require.cache[sqlPath] = { id: sqlPath, filename: sqlPath, loaded: true, exports: { poolPromise: Promise.resolve(pool) } };

process.env.BREVO_FROM_EMAIL = "shop@example.test";
const mailer = require(path.join(root, "config", "mailer.js"));
const mails = [];
mailer.transporter.sendMail = async (message) => {
  mails.push(message);
  return {};
};

const orderEmail = require(path.join(root, "services", "order-email.service.js"));
const membershipEmail = require(path.join(root, "services", "membership-email.service.js"));
const settle = () => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => {
  orders.length = 0;
  subs.length = 0;
  log.clear();
  mails.length = 0;
});

test("shipped: one branded e-mail, repeats send nothing, wrong status sends nothing", async () => {
  orders.push({ id: "o1", user_id: "u1", order_number: "K-1", status: "Shipped" });

  assert.equal((await orderEmail.sendOrderStatusEmail("o1", "Shipped")).sent, true);
  assert.equal((await orderEmail.sendOrderStatusEmail("o1", "Shipped")).duplicate, true);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].from.name, "KOVENIK");
  assert.equal(mails[0].subject, "Your KOVENIK order K-1 is on its way");
  assert.ok(mails[0].html.includes("/orders/o1") && mails[0].text.includes("/orders/o1"));

  // the order moved on before the e-mail ran
  assert.equal((await orderEmail.sendOrderStatusEmail("o1", "Delivered")).skipped, "status_changed");
  assert.equal((await orderEmail.sendOrderStatusEmail("o1", "Packed")).skipped, "no_template");
  assert.equal(mails.length, 1);
});

test("delivered: sent once", async () => {
  orders.push({ id: "o1", user_id: "u1", order_number: "K-1", status: "Delivered" });
  await orderEmail.sendOrderStatusEmail("o1", "Delivered");
  await orderEmail.sendOrderStatusEmail("o1", "Delivered");
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /was delivered/);
});

test("payment failed: only for a Failed order, only once", async () => {
  orders.push({ id: "o1", user_id: "u1", order_number: "K-1", total_amount: "1265.00", payment_status: "Pending" });
  assert.equal((await orderEmail.sendPaymentFailed("o1")).skipped, "not_failed");

  orders[0].payment_status = "Failed";
  assert.equal((await orderEmail.sendPaymentFailed("o1")).sent, true);
  assert.equal((await orderEmail.sendPaymentFailed("o1")).duplicate, true);
  assert.equal(mails.length, 1);
  assert.match(mails[0].text, /₹1,265\.00/);
});

test("membership reminders: expiring in 7 days and expired, each once; queued renewal sends neither", async () => {
  const now = new Date("2027-01-10T00:00:00Z");
  const day = 86400000;
  subs.push({ id: "s1", user_id: "u1", status: "active", end_date: new Date(now.getTime() + 3 * day) });
  subs.push({ id: "s2", user_id: "u2", status: "expired", end_date: new Date(now.getTime() - 1 * day) });

  await membershipEmail.membershipLifecycle(pool, now);
  await membershipEmail.membershipLifecycle(pool, now); // sweep runs again: nothing new
  await settle();
  await settle();

  const subjects = mails.map((m) => m.subject).sort();
  assert.deepEqual(subjects, ["Your KOVENIK membership ends soon", "Your KOVENIK membership has ended"]);
  assert.ok(mails.every((m) => m.from.name === "KOVENIK" && m.html.includes("/membership")));

  // A queued renewal means the customer is still a member: no reminder, no "ended" mail.
  mails.length = 0;
  log.clear();
  subs.push({ id: "s3", user_id: "u1", status: "active", end_date: new Date(now.getTime() + 400 * day) });
  subs.push({ id: "s4", user_id: "u2", status: "active", end_date: new Date(now.getTime() + 400 * day) });
  await membershipEmail.membershipLifecycle(pool, now);
  await settle();
  await settle();
  assert.equal(mails.length, 0);
});

test("membership purchase mail is deduplicated by its key", async () => {
  membershipEmail.notifyMembership("u1", {
    dedupeKey: "membership-activated:s9",
    template: "membership_activated",
    data: { amount: 199, startDate: new Date("2026-11-09"), endDate: new Date("2027-11-09") },
  });
  membershipEmail.notifyMembership("u1", {
    dedupeKey: "membership-activated:s9",
    template: "membership_activated",
    data: { amount: 199, startDate: new Date("2026-11-09"), endDate: new Date("2027-11-09") },
  });
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, "Welcome to KOVENIK Member");
});
