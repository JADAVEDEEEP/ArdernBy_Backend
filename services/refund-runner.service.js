const { poolPromise } = require("../config/sql");
const orderService = require("./order.service");
const razorpay = require("./razorpay.service");

// ==========================================
// REFUND RUNNER
//
// One place that sends a refund to Razorpay for a cancellation or a return, and
// records the outcome. Refund status vocabulary (separate from the order status
// and the payment status):
//
//   not_applicable  nothing was paid online, or nothing is refundable
//   pending         decided, not yet sent to Razorpay
//   processing      Razorpay accepted it but has NOT said it is processed
//   completed       Razorpay says processed (or an admin confirmed a manual payout)
//   failed          could not be started / Razorpay failed it; safe to retry
//
// "Completed" is only ever written from a Razorpay "processed" answer. Accepting
// the API call is "processing", never "completed".
//
// Duplicate protection (three layers):
//   1. the row is CLAIMED with a conditional UPDATE before Razorpay is called, so
//      two simultaneous attempts cannot both send;
//   2. the refund carries a key (Razorpay "receipt") unique to this one refund, and
//      a retry first looks for that refund instead of creating another;
//   3. completed rows are never overwritten.
// ==========================================

const TABLES = {
  order_cancellations: "c",
  return_requests: "r",
};

const refKeyFor = (table, id) => `${TABLES[table]}${id}`;

const tableOk = (table) => {
  if (!TABLES[table]) throw new Error("Unknown refund table.");
  return table;
};

// How long an unfinished attempt (no Razorpay refund id recorded yet) is trusted
// before a retry may take over. Guards against double refunds on a slow request.
const STALE_ATTEMPT_SECONDS = 120;

const shortError = (message) => String(message || "").slice(0, 280);

// Sends (or adopts) the refund for one row. `order` needs id and payment_id;
// `amount` is the rupee amount decided by the server-side calculation.
const runRefund = async ({ table, id, order, amount }) => {
  tableOk(table);
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `SELECT refund_status, refund_id, TIMESTAMPDIFF(SECOND, updated_at, UTC_TIMESTAMP(6)) AS age
     FROM ${table} WHERE id = ? LIMIT 1`,
    [id]
  );
  const row = rows[0];
  if (!row) return { ran: false, status: null, reason: "not_found" };
  if (["completed", "not_applicable"].includes(row.refund_status)) {
    return { ran: false, status: row.refund_status, reason: "already_final" };
  }
  if (!(Number(amount) > 0)) return { ran: false, status: row.refund_status, reason: "no_amount" };
  if (!order.payment_id) return { ran: false, status: row.refund_status, reason: "no_payment" };

  // CLAIM: only one attempt may proceed.
  //  - pending / failed rows are claimed outright
  //  - a processing row is re-checked only when it HAS a refund id (we just look
  //    the refund up), or when the earlier attempt is stale
  let claimed;
  if (["pending", "failed"].includes(row.refund_status)) {
    [claimed] = await pool.execute(
      `UPDATE ${table} SET refund_status = 'processing', refund_error = NULL, updated_at = UTC_TIMESTAMP(6)
       WHERE id = ? AND refund_status IN ('pending', 'failed')`,
      [id]
    );
  } else {
    const takeOver = Boolean(row.refund_id) || Number(row.age) >= STALE_ATTEMPT_SECONDS;
    if (!takeOver) return { ran: false, status: "processing", reason: "in_flight" };
    [claimed] = await pool.execute(
      `UPDATE ${table} SET updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND refund_status = 'processing'`,
      [id]
    );
  }
  if (claimed.affectedRows !== 1) return { ran: false, status: row.refund_status, reason: "in_flight" };

  // A refund that already has a Razorpay id exists. It is only ever LOOKED UP from here on:
  // a retry must never be able to send a second one for the same cancellation / return.
  if (row.refund_status === "processing" && row.refund_id) {
    const looked = await checkStatus({ table, id });
    return { ran: true, status: looked.status || "processing", refundId: row.refund_id, lookedUp: true };
  }

  let result;
  try {
    result = await orderService.initiateRefund(
      { id: order.id, payment_id: order.payment_id, total_amount: amount },
      { refKey: refKeyFor(table, id) }
    );
  } catch (error) {
    // Razorpay unreachable: leave it 'processing' with a note, so the stale-attempt
    // rule lets a retry look for the refund by its key before creating anything.
    await pool.execute(
      `UPDATE ${table} SET refund_error = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND refund_status = 'processing'`,
      [shortError("Could not reach Razorpay: " + error.message), id]
    );
    return { ran: true, status: "processing", error: error.message };
  }

  if (result.outcome === "unknown") {
    // Outcome unknown: stay 'processing' (never 'completed', never 'failed'). The row
    // keeps no refund id, so a retry first waits out the stale-attempt window and then
    // looks the refund up by its receipt instead of creating a second one.
    await pool.execute(
      `UPDATE ${table} SET refund_error = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND refund_status = 'processing'`,
      [shortError(result.message), id]
    );
    return { ran: true, status: "processing", error: result.message, unknown: true };
  }

  if (result.outcome === "deferred") {
    await pool.execute(
      `UPDATE ${table} SET refund_status = 'failed', refund_error = ?, updated_at = UTC_TIMESTAMP(6)
       WHERE id = ? AND refund_status = 'processing'`,
      [shortError(result.message), id]
    );
    return { ran: true, status: "failed", error: result.message };
  }

  const done = result.refundStatus === "processed";
  await pool.execute(
    `UPDATE ${table}
     SET refund_status = ?, refund_id = ?, refund_error = NULL,
         refund_completed_at = ${done ? "UTC_TIMESTAMP(6)" : "refund_completed_at"},
         updated_at = UTC_TIMESTAMP(6)
     WHERE id = ? AND refund_status IN ('processing', 'pending', 'failed')`,
    [done ? "completed" : "processing", result.refundId || null, id]
  );
  return { ran: true, status: done ? "completed" : "processing", refundId: result.refundId || null };
};

// Asks Razorpay what happened to OUR refund and records it. READ-ONLY towards Razorpay:
// this function can never create a refund (it only lists the payment's refunds), and it only
// moves our record forward (processing/failed -> completed, or -> failed). Safe to call any
// number of times, by an admin or by the automatic sync.
//   { checked:false, reason }                     nothing to look at / Razorpay unreadable
//   { checked:true, found:false }                 Razorpay does not list it (left unchanged)
//   { checked:true, found:true, razorpayStatus, status, changed }
const checkStatus = async ({ table, id }) => {
  tableOk(table);
  const pool = await poolPromise;

  const [rows] = await pool.execute(`SELECT order_id, refund_status, refund_id FROM ${table} WHERE id = ? LIMIT 1`, [id]);
  const row = rows[0];
  if (!row) return { checked: false, reason: "not_found" };
  if (["completed", "not_applicable"].includes(row.refund_status)) {
    return { checked: false, reason: "already_final", status: row.refund_status };
  }
  if (row.refund_status === "pending") {
    // Never sent to Razorpay: there is nothing to look up. Sending is the Retry button's job.
    return { checked: false, reason: "not_sent", status: "pending" };
  }

  const [orders] = await pool.execute("SELECT payment_id FROM orders WHERE id = ? LIMIT 1", [row.order_id]);
  const paymentId = orders[0]?.payment_id;
  if (!paymentId) return { checked: false, reason: "no_payment", status: row.refund_status };

  const list = await razorpay.fetchPaymentRefunds(paymentId);
  if (list === null) return { checked: false, reason: "razorpay_unreadable", status: row.refund_status };

  const key = refKeyFor(table, id);
  const mine = list.filter((r) => (row.refund_id && r.id === row.refund_id) || r.receipt === key || r.notes?.ref === key);
  // Prefer the one we recorded, then any that is not failed.
  const ours =
    mine.find((r) => row.refund_id && r.id === row.refund_id) ||
    mine.find((r) => String(r.status).toLowerCase() !== "failed") ||
    mine[0];
  if (!ours) return { checked: true, found: false, status: row.refund_status };

  const razorpayStatus = String(ours.status || "").toLowerCase();
  if (razorpayStatus === "processed" || razorpayStatus === "failed") {
    const applied = await applyRefundEvent({ refundId: ours.id, receipt: key, status: razorpayStatus });
    return { checked: true, found: true, razorpayStatus, status: applied.status || row.refund_status, changed: Boolean(applied.changed), refundId: ours.id };
  }

  // Still pending at Razorpay: remember its id (so later checks look it up directly), nothing else changes.
  if (!row.refund_id && ours.id && row.refund_status === "processing") {
    await pool.execute(`UPDATE ${table} SET refund_id = ? WHERE id = ? AND refund_status = 'processing' AND refund_id IS NULL`, [ours.id, id]);
  }
  return { checked: true, found: true, razorpayStatus, status: row.refund_status, changed: false, refundId: ours.id };
};

// A Razorpay refund event (webhook). Matches OUR refund by its receipt key or its
// id and moves the status forward. Returns what changed, so the caller can do the
// follow-ups (e-mails, completing a return, syncing the order's payment status).
//   processed -> completed, failed -> failed. Completed rows never move.
const applyRefundEvent = async ({ refundId, receipt, status }) => {
  const pool = await poolPromise;
  const wanted = String(status || "").toLowerCase();
  if (!["processed", "failed"].includes(wanted)) return { matched: false, reason: "ignored_status" };

  const candidates = [];
  const key = typeof receipt === "string" ? receipt : "";
  for (const [table, prefix] of Object.entries(TABLES)) {
    if (key.startsWith(prefix) && key.length > 30) {
      candidates.push({ table, id: key.slice(1), by: "receipt" });
    }
  }
  for (const table of Object.keys(TABLES)) {
    if (refundId) {
      const [found] = await pool.execute(`SELECT id FROM ${table} WHERE refund_id = ? LIMIT 1`, [refundId]);
      if (found[0]) candidates.push({ table, id: found[0].id, by: "refund_id" });
    }
  }

  for (const candidate of candidates) {
    const [rows] = await pool.execute(`SELECT refund_status FROM ${candidate.table} WHERE id = ? LIMIT 1`, [candidate.id]);
    if (!rows[0]) continue;
    if (rows[0].refund_status === "completed") return { matched: true, changed: false, ...candidate };

    const target = wanted === "processed" ? "completed" : "failed";
    const [updated] = await pool.execute(
      `UPDATE ${candidate.table}
       SET refund_status = ?, refund_id = COALESCE(refund_id, ?),
           refund_error = ${target === "failed" ? "'Razorpay reported the refund as failed.'" : "NULL"},
           refund_completed_at = ${target === "completed" ? "UTC_TIMESTAMP(6)" : "refund_completed_at"},
           updated_at = UTC_TIMESTAMP(6)
       WHERE id = ? AND refund_status <> 'completed'`,
      [target, refundId || null, candidate.id]
    );
    return { matched: true, changed: updated.affectedRows === 1, status: target, ...candidate };
  }
  return { matched: false, reason: "not_ours" };
};

module.exports = { runRefund, checkStatus, applyRefundEvent, refKeyFor, STALE_ATTEMPT_SECONDS };
