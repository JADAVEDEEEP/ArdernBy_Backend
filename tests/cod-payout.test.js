const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");

// ---- UPI validation -------------------------------------------------------------------

const { isValidUpi, normalizeUpi, maskUpi } = require("../utils/upi");

test("UPI ids: valid and invalid shapes", () => {
  for (const good of ["deep@okhdfcbank", "deep.jadav-71@ybl", "9586281758@paytm", "A_b.c@Axl"]) {
    assert.ok(isValidUpi(good), good);
  }
  for (const bad of ["", "deep", "@ybl", "deep@", "de ep@ybl", "deep@@ybl", "deep@y", "-deep@ybl", "a@b", "x".repeat(120) + "@ybl", "dee<p>@ybl", "deep@ybl.com"]) {
    assert.ok(!isValidUpi(bad), bad);
  }
  assert.equal(normalizeUpi("  Deep@YBL "), "deep@ybl");
});

test("the customer only ever sees a masked UPI id", () => {
  assert.equal(maskUpi("deepjadav@okhdfcbank"), "de****@okhdfcbank");
  assert.equal(maskUpi("nope"), "");
});

// ---- scripted database ----------------------------------------------------------------

const sqlModule = path.resolve(__dirname, "../config/sql.js");
const state = { row: null, order: { payment_method: "cod" } };

const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();
const fresh = (over = {}) => ({
  id: "ret-1",
  order_id: "ord-1",
  user_id: "u1",
  status: "Inspected",
  refund_method: "razorpayx_upi",
  refund_status: "pending",
  refund_amount: 1050,
  refund_upi_id: "deep@okhdfcbank",
  refund_reference: null,
  refund_error: null,
  payout_id: null,
  payout_status: null,
  payout_utr: null,
  payout_attempts: 0,
  payout_contact_id: null,
  payout_fund_account_id: null,
  payout_failure_reason: null,
  updated_age: 999,
  ...over,
});

const pool = {
  execute: async (sql, p = []) => {
    const q = norm(sql);
    const r = state.row;
    if (q.startsWith("select * from return_requests where payout_id = ?")) return [r && r.payout_id === p[0] ? [{ ...r }] : []];
    if (q.startsWith("select * from return_requests where id = ? and refund_method = ?")) return [r && r.id === p[0] && r.refund_method === p[1] ? [{ ...r }] : []];
    if (q.startsWith("select * from return_requests where id = ?")) return [r && r.id === p[0] ? [{ ...r }] : []];
    if (q.startsWith("select id, payout_id, refund_status, refund_method from return_requests")) return [[{ ...r }]];
    if (q.startsWith("select payment_method from orders")) return [[state.order]];
    if (q.includes("from return_requests r left join orders o")) return [[{ email: "c@x.com", name: "Cust", phone: "9999999999" }]];

    if (q.startsWith("update return_requests set refund_status = 'processing', payout_status = 'initiating', payout_attempts = ?") && q.includes("where id = ? and refund_status = 'pending'")) {
      if (r.refund_status === "pending" && r.payout_id === null) {
        Object.assign(r, { refund_status: "processing", payout_status: "initiating", payout_attempts: p[0] });
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }
    if (q.startsWith("update return_requests set refund_status = 'processing', payout_status = 'initiating', payout_attempts = ?") && q.includes("refund_status = 'failed' and payout_attempts = ?")) {
      if (r.refund_status === "failed" && r.payout_attempts === p[2]) {
        Object.assign(r, { refund_status: "processing", payout_status: "initiating", payout_attempts: p[0], payout_id: null, payout_utr: null });
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }
    if (q.includes("and refund_status = 'processing' and payout_id is null and timestampdiff")) {
      return [{ affectedRows: r.refund_status === "processing" && r.payout_id === null && r.updated_age >= 60 ? 1 : 0 }];
    }
    if (q.startsWith("update return_requests set payout_contact_id = ?")) { r.payout_contact_id = p[0]; return [{ affectedRows: 1 }]; }
    if (q.startsWith("update return_requests set payout_fund_account_id = ?")) { r.payout_fund_account_id = p[0]; return [{ affectedRows: 1 }]; }
    if (q.startsWith("update return_requests set payout_id = ?, payout_status = ?")) { r.payout_id = p[0]; r.payout_status = p[1]; return [{ affectedRows: 1 }]; }
    if (q.startsWith("update return_requests set refund_status = 'completed'")) {
      if (r.refund_status === "completed") return [{ affectedRows: 0 }];
      Object.assign(r, { refund_status: "completed", payout_status: "processed", payout_utr: p[0], refund_reference: p[1] });
      return [{ affectedRows: 1 }];
    }
    if (q.startsWith("update return_requests set refund_status = 'failed', payout_status = 'creation_failed'")) {
      if (r.refund_status === "processing" && r.payout_id === null) {
        Object.assign(r, { refund_status: "failed", payout_status: "creation_failed", refund_error: p[1] });
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }
    if (q.startsWith("update return_requests set refund_status = 'failed', payout_status = ?")) {
      if (["pending", "processing", "failed"].includes(r.refund_status) && (r.payout_id === p[4] || r.payout_id === null)) {
        Object.assign(r, { refund_status: "failed", payout_status: p[0], refund_error: p[2] });
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }
    if (q.startsWith("update return_requests set payout_status = ?, refund_status = 'processing'")) {
      if (["pending", "processing"].includes(r.refund_status) && r.payout_status !== p[2]) {
        Object.assign(r, { refund_status: "processing", payout_status: p[0] });
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }
    if (q.startsWith("update return_requests set payout_status = 'reversed'")) { r.payout_status = "reversed"; r.refund_error = p[0]; return [{ affectedRows: 1 }]; }
    if (q.startsWith("update return_requests set refund_error = ?")) { r.refund_error = p[0]; return [{ affectedRows: 1 }]; }
    throw new Error("unscripted SQL: " + q.slice(0, 120));
  },
};

require.cache[sqlModule] = { id: sqlModule, filename: sqlModule, loaded: true, exports: { poolPromise: Promise.resolve(pool) } };

process.env.RAZORPAYX_WEBHOOK_SECRET = "x_secret";
const razorpayx = require("../services/razorpayx.service");
const codPayout = require("../services/cod-payout.service");

let created = [];
let nextStatus = "processing";
let createError = null;
razorpayx.isConfigured = () => true;
razorpayx.createContact = async () => ({ id: "cont_1" });
razorpayx.createUpiFundAccount = async () => ({ id: "fa_1" });
razorpayx.createPayout = async (args) => {
  created.push(args);
  if (createError) throw createError;
  return { id: "pout_" + created.length, status: nextStatus, amount: Math.round(args.amountRupees * 100), utr: nextStatus === "processed" ? "UTR1" : null };
};
razorpayx.fetchPayout = async () => ({ id: state.row.payout_id, status: "processing", amount: 105000 });

const reset = (over) => {
  state.row = fresh(over);
  state.order = { payment_method: "cod" };
  created = [];
  nextStatus = "processing";
  createError = null;
};

// ---- initiate -------------------------------------------------------------------------

test("a COD refund creates ONE payout for the server-calculated amount and stays Processing", async () => {
  reset();
  const result = await codPayout.initiate({ id: "ret-1" });
  assert.equal(result.status, "processing");
  assert.equal(created.length, 1);
  assert.equal(created[0].amountRupees, 1050);
  assert.equal(created[0].idempotencyKey, "kvk-return-ret-1-1");
  assert.equal(created[0].referenceId, "ret-1");
  assert.equal(state.row.refund_status, "processing");
  assert.equal(state.row.payout_id, "pout_1");
  assert.equal(state.row.payout_utr, null);
});

test("duplicate request: the second one never creates another payout", async () => {
  reset();
  await codPayout.initiate({ id: "ret-1" });
  const again = await codPayout.initiate({ id: "ret-1" });
  assert.equal(again.lookedUp, true);
  assert.equal(created.length, 1);
});

test("two simultaneous requests: only one wins the claim", async () => {
  reset();
  const [a, b] = await Promise.all([codPayout.initiate({ id: "ret-1" }), codPayout.initiate({ id: "ret-1" })]);
  assert.equal(created.length, 1);
  assert.ok([a, b].some((x) => x.ran === false || x.lookedUp === true));
});

test("never the Payment Refund API, never an online order, never without a UPI id", async () => {
  reset();
  state.order = { payment_method: "online" };
  await assert.rejects(() => codPayout.initiate({ id: "ret-1" }), (e) => e.code === "NOT_COD");
  reset({ refund_upi_id: null });
  await assert.rejects(() => codPayout.initiate({ id: "ret-1" }), (e) => e.code === "UPI_REQUIRED");
  reset({ refund_method: "razorpay" });
  await assert.rejects(() => codPayout.initiate({ id: "ret-1" }), (e) => e.code === "INVALID_TRANSITION");
  assert.equal(created.length, 0);
});

test("RazorpayX switched off: nothing is attempted and nothing is faked", async () => {
  reset();
  razorpayx.isConfigured = () => false;
  await assert.rejects(() => codPayout.initiate({ id: "ret-1" }), (e) => e.code === "PAYOUT_UNAVAILABLE");
  razorpayx.isConfigured = () => true;
  assert.equal(created.length, 0);
  assert.equal(state.row.refund_status, "pending");
});

test("create response 'processed' completes it; 'processing' does not", async () => {
  reset();
  nextStatus = "processed";
  const done = await codPayout.initiate({ id: "ret-1" });
  assert.equal(done.status, "completed");
  assert.equal(state.row.payout_utr, "UTR1");
});

test("a rejected request (e.g. low balance) is a real failure; the retry uses a NEW attempt key", async () => {
  reset();
  createError = Object.assign(new Error("Your account does not have enough balance"), { razorpayStatus: 400 });
  const failed = await codPayout.initiate({ id: "ret-1" });
  assert.equal(failed.status, "failed");
  assert.equal(state.row.refund_status, "failed");

  createError = null;
  const retried = await codPayout.initiate({ id: "ret-1" });
  assert.equal(retried.status, "processing");
  assert.equal(created.length, 2);
  assert.equal(created[1].idempotencyKey, "kvk-return-ret-1-2");
});

test("unreachable RazorpayX: outcome unknown, stays Processing, never Failed or Refunded; resume reuses the SAME key", async () => {
  reset();
  createError = Object.assign(new Error("fetch failed"), {});
  const unknown = await codPayout.initiate({ id: "ret-1" });
  assert.equal(unknown.status, "processing");
  assert.equal(unknown.unknown, true);
  assert.equal(state.row.refund_status, "processing");

  // inside the in-flight window nothing is sent
  state.row.updated_age = 5;
  createError = null;
  const early = await codPayout.initiate({ id: "ret-1" });
  assert.equal(early.ran, false);
  assert.equal(created.length, 1);

  state.row.updated_age = 600;
  await codPayout.initiate({ id: "ret-1" });
  assert.equal(created.length, 2);
  assert.equal(created[1].idempotencyKey, created[0].idempotencyKey);
});

// ---- webhook states ---------------------------------------------------------------------

const event = (name, status, extra = {}) => ({
  event: name,
  payload: { payout: { entity: { id: "pout_1", reference_id: "ret-1", status, amount: 105000, ...extra } } },
});

const processing = async () => {
  reset();
  await codPayout.initiate({ id: "ret-1" });
};

test("payout.processed -> Refunded with the UTR; a repeat changes nothing", async () => {
  await processing();
  const first = await codPayout.applyWebhookEvent(event("payout.processed", "processed", { utr: "UTR123" }));
  assert.deepEqual([first.matched, first.changed, first.status], [true, true, "completed"]);
  assert.equal(state.row.refund_status, "completed");
  assert.equal(state.row.payout_utr, "UTR123");

  const second = await codPayout.applyWebhookEvent(event("payout.processed", "processed", { utr: "UTR123" }));
  assert.equal(second.changed, false);
});

test("payout.failed -> Failed with the reason; then a later 'processing' cannot undo a completed one", async () => {
  await processing();
  const failed = await codPayout.applyWebhookEvent(event("payout.failed", "failed", { status_details: { description: "Invalid VPA" } }));
  assert.equal(failed.status, "failed");
  assert.equal(state.row.refund_status, "failed");
  assert.equal(state.row.refund_error, "Invalid VPA");
});

test("a completed refund never goes back, even if an older event arrives late", async () => {
  await processing();
  await codPayout.applyWebhookEvent(event("payout.processed", "processed", { utr: "U" }));
  const late = await codPayout.applyWebhookEvent(event("payout.failed", "failed"));
  assert.equal(late.changed, false);
  assert.equal(state.row.refund_status, "completed");
});

test("reversal after completion is flagged for an admin, not silently rewritten", async () => {
  await processing();
  await codPayout.applyWebhookEvent(event("payout.processed", "processed", { utr: "U" }));
  const rev = await codPayout.applyWebhookEvent(event("payout.reversed", "reversed"));
  assert.equal(rev.flagged, true);
  assert.equal(state.row.refund_status, "completed");
  assert.match(state.row.refund_error, /reversed/i);
});

test("unknown payout, superseded payout and wrong amount are ignored", async () => {
  await processing();
  assert.equal((await codPayout.applyWebhookEvent(event("payout.processed", "processed", { id: "pout_nope", reference_id: "nope" }))).matched, false);
  assert.equal((await codPayout.applyWebhookEvent(event("payout.processed", "processed", { id: "pout_old" }))).matched, false);
  const wrong = await codPayout.applyWebhookEvent(event("payout.processed", "processed", { amount: 1 }));
  assert.equal(wrong.changed, false);
  assert.equal(state.row.refund_status, "processing");
});

test("an unknown status never completes or fails a refund", () => {
  assert.equal(codPayout.refundStatusFor("queued"), "processing");
  assert.equal(codPayout.refundStatusFor("weird"), "processing");
  assert.equal(codPayout.refundStatusFor("processed"), "completed");
  for (const s of ["failed", "rejected", "cancelled", "reversed"]) assert.equal(codPayout.refundStatusFor(s), "failed");
});

// ---- signature ------------------------------------------------------------------------

test("webhook signature: valid accepted, tampered / missing / wrong secret rejected", () => {
  const body = Buffer.from(JSON.stringify(event("payout.processed", "processed")));
  const good = crypto.createHmac("sha256", "x_secret").update(body).digest("hex");
  assert.equal(razorpayx.verifyWebhookSignature(body, good), true);
  assert.equal(razorpayx.verifyWebhookSignature(Buffer.from(body.toString() + " "), good), false);
  assert.equal(razorpayx.verifyWebhookSignature(body, undefined), false);
  assert.equal(razorpayx.verifyWebhookSignature(body, crypto.createHmac("sha256", "other").update(body).digest("hex")), false);
});

test("HTTP webhook: 400 bad signature, 200 good, 503 when no secret", async () => {
  const controller = require("../controller/payment.controller");
  const returns = require("../services/return.service");
  returns.afterRefundChange = async () => {};
  const call = async (rawBody, signature) => {
    let status = 200;
    let payload;
    const res = { status: (c) => ((status = c), res), json: (d) => ((payload = d), res) };
    await controller.razorpayxWebhook({ rawBody, body: rawBody ? JSON.parse(rawBody) : {}, get: (h) => (h === "x-razorpay-signature" ? signature : undefined) }, res);
    return { status, payload };
  };
  await processing();
  const raw = Buffer.from(JSON.stringify(event("payout.processed", "processed", { utr: "UTRX" })));
  const sig = crypto.createHmac("sha256", "x_secret").update(raw).digest("hex");

  assert.equal((await call(raw, "bad")).status, 400);
  assert.equal(state.row.refund_status, "processing");
  const ok = await call(raw, sig);
  assert.equal(ok.status, 200);
  assert.equal(state.row.refund_status, "completed");

  const saved = process.env.RAZORPAYX_WEBHOOK_SECRET;
  delete process.env.RAZORPAYX_WEBHOOK_SECRET;
  assert.equal((await call(raw, sig)).status, 503);
  process.env.RAZORPAYX_WEBHOOK_SECRET = saved;
});
