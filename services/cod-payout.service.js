const { poolPromise } = require("../config/sql");
const razorpayx = require("./razorpayx.service");
const calc = require("./refund-calc.service");

// ==========================================
// COD REFUND -> RazorpayX UPI PAYOUT
//
// return_requests.refund_status moves   pending -> processing -> completed | failed
// (shown to customers as Pending / Processing / Refunded / Failed).
//
//   * Money is only ever sent from here, and the amount is always the server-calculated
//     return_requests.refund_amount (never anything the browser sent).
//   * "completed" is written ONLY when RazorpayX reports the payout as processed (signed
//     webhook, or a read-back of the payout), never from our own create call.
//   * Duplicates are prevented three ways: refund_status is claimed with a conditional
//     UPDATE, a payout that already has an id is only ever LOOKED UP, and every create
//     carries an idempotency key (return id + attempt number) so even a repeated call
//     after a timeout returns the same payout. A new attempt number is used only after
//     RazorpayX CONFIRMED the previous one failed.
// ==========================================

const METHOD = "razorpayx_upi";

const FAILED = ["failed", "rejected", "cancelled", "reversed", "creation_failed"];

const short = (text, max = 290) => String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
const toPaise = (value) => calc.toPaise(value);

const fail = (statusCode, message, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

// RazorpayX status -> our refund_status. Anything unknown stays "processing": we never
// guess a success or a failure.
const refundStatusFor = (payoutStatus) => {
  const status = String(payoutStatus || "").toLowerCase();
  if (status === "processed") return "completed";
  if (FAILED.includes(status)) return "failed";
  return "processing";
};

const firstRow = (result) => (Array.isArray(result) && Array.isArray(result[0]) ? result[0][0] : undefined);

// Applies what RazorpayX says about a payout to the return it belongs to. Forward-only
// and repeatable: a completed refund never goes back, and the same event twice changes
// nothing. Used by the webhook and by the status check.
const applyPayoutState = async ({ payoutId, referenceId, status, utr, failureReason, amountPaise }) => {
  const pool = await poolPromise;
  let row;
  if (payoutId) {
    row = firstRow(await pool.execute("SELECT * FROM return_requests WHERE payout_id = ? LIMIT 1", [payoutId]));
  }
  if (!row && referenceId) {
    row = firstRow(
      await pool.execute("SELECT * FROM return_requests WHERE id = ? AND refund_method = ? LIMIT 1", [String(referenceId), METHOD])
    );
  }
  if (!row) return { matched: false, reason: "unknown_payout" };

  // A payout we are not tracking any more (an older attempt) must not move the refund.
  if (payoutId && row.payout_id && row.payout_id !== payoutId) return { matched: false, reason: "superseded_payout" };

  if (amountPaise != null && Number(amountPaise) !== toPaise(row.refund_amount)) {
    console.error("RazorpayX payout amount mismatch for return", row.id, "- ignored.");
    return { matched: true, changed: false, id: row.id, reason: "amount_mismatch" };
  }

  const payoutStatus = String(status || "").toLowerCase();
  const next = refundStatusFor(payoutStatus);

  if (row.refund_status === "completed") {
    if (payoutStatus === "reversed") {
      // Money came back after it was marked paid: the ledger is NOT rewritten silently;
      // it is flagged for an admin to follow up.
      await pool.execute(
        `UPDATE return_requests SET payout_status = 'reversed', refund_error = ?, updated_at = UTC_TIMESTAMP(6)
         WHERE id = ? AND refund_status = 'completed'`,
        [short("RazorpayX reversed this payout after it was processed. Pay the customer manually."), row.id]
      );
      console.error("RazorpayX payout REVERSED after completion for return", row.id);
      return { matched: true, changed: true, id: row.id, flagged: true };
    }
    return { matched: true, changed: false, id: row.id };
  }

  if (next === "completed") {
    const [result] = await pool.execute(
      `UPDATE return_requests
       SET refund_status = 'completed', payout_status = 'processed', payout_utr = ?, refund_reference = ?,
           refund_error = NULL, payout_failure_reason = NULL,
           payout_completed_at = UTC_TIMESTAMP(6), refund_completed_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
       WHERE id = ? AND refund_status <> 'completed'`,
      [utr || null, short(utr || row.payout_id || "", 100) || null, row.id]
    );
    return { matched: true, changed: result.affectedRows === 1, id: row.id, status: "completed" };
  }

  if (next === "failed") {
    const reason = short(failureReason || `RazorpayX reported the payout as ${payoutStatus}.`);
    const [result] = await pool.execute(
      `UPDATE return_requests
       SET refund_status = 'failed', payout_status = ?, payout_failure_reason = ?, refund_error = ?, updated_at = UTC_TIMESTAMP(6)
       WHERE id = ? AND refund_status IN ('pending', 'processing', 'failed') AND (payout_id = ? OR payout_id IS NULL)`,
      [payoutStatus, reason, reason, row.id, payoutId || row.payout_id || null]
    );
    return { matched: true, changed: result.affectedRows === 1 && row.refund_status !== "failed", id: row.id, status: "failed" };
  }

  // Still on its way: only record the finer status.
  const finer = payoutStatus || "processing";
  const [result] = await pool.execute(
    `UPDATE return_requests SET payout_status = ?, refund_status = 'processing', updated_at = UTC_TIMESTAMP(6)
     WHERE id = ? AND refund_status IN ('pending', 'processing') AND (payout_status IS NULL OR payout_status <> ?)`,
    [finer, row.id, finer]
  );
  return { matched: true, changed: result.affectedRows === 1 && row.refund_status !== "processing", id: row.id, status: "processing" };
};

const applyWebhookEvent = (event) => {
  const payout = event && event.payload && event.payload.payout && event.payload.payout.entity;
  if (!payout) return Promise.resolve({ matched: false, reason: "no_payout" });
  return applyPayoutState({
    payoutId: payout.id,
    referenceId: payout.reference_id,
    status: payout.status || String(event.event || "").replace(/^payout\./, ""),
    utr: payout.utr,
    failureReason: (payout.status_details && payout.status_details.description) || payout.failure_reason,
    amountPaise: payout.amount,
  });
};

// Reads the payout back from RazorpayX and applies it (for a missed webhook).
const checkPayout = async ({ id }) => {
  const pool = await poolPromise;
  const row = firstRow(
    await pool.execute("SELECT id, payout_id, refund_status, refund_method FROM return_requests WHERE id = ? LIMIT 1", [id])
  );
  if (!row || row.refund_method !== METHOD) return { checked: false, reason: "not_a_payout" };
  if (!row.payout_id) return { checked: false, reason: "no_payout_yet", status: row.refund_status };
  if (row.refund_status === "completed") return { checked: false, reason: "already_final", status: "completed" };
  if (!razorpayx.isConfigured()) return { checked: false, reason: "unavailable", status: row.refund_status };

  let payout;
  try {
    payout = await razorpayx.fetchPayout(row.payout_id);
  } catch (_error) {
    return { checked: false, reason: "razorpayx_unreadable", status: row.refund_status };
  }
  const applied = await applyPayoutState({
    payoutId: payout.id,
    referenceId: id,
    status: payout.status,
    utr: payout.utr,
    failureReason: payout.status_details && payout.status_details.description,
    amountPaise: payout.amount,
  });
  return { checked: true, ...applied, razorpayStatus: payout.status };
};

// Starts (or safely resumes) the payout for a return whose refund is decided.
const initiate = async ({ id }) => {
  if (!razorpayx.isConfigured()) {
    throw fail(503, "RazorpayX payouts are not available. Use the manual UPI refund.", "PAYOUT_UNAVAILABLE");
  }

  const pool = await poolPromise;
  const row = firstRow(await pool.execute("SELECT * FROM return_requests WHERE id = ? LIMIT 1", [id]));
  if (!row) throw fail(404, "Return request not found.");
  if (row.refund_method !== METHOD) throw fail(409, "This refund is not set up for a RazorpayX payout.", "INVALID_TRANSITION");
  if (row.status !== "Inspected") throw fail(409, "The refund can only be paid after the items are inspected.", "INVALID_TRANSITION");
  if (row.refund_status === "completed") throw fail(409, "This refund was already paid.", "REFUND_ALREADY_PROCESSED");
  if (!(Number(row.refund_amount) > 0)) throw fail(409, "There is no amount to pay.", "INVALID_TRANSITION");

  const order = firstRow(await pool.execute("SELECT payment_method FROM orders WHERE id = ? LIMIT 1", [row.order_id]));
  if (!order || String(order.payment_method).toLowerCase() !== "cod") {
    // Online orders are refunded through the Razorpay Payment Refund API, never here.
    throw fail(409, "Payouts are only for cash-on-delivery orders.", "NOT_COD");
  }
  if (!row.refund_upi_id) throw fail(409, "The customer has not given a UPI ID.", "UPI_REQUIRED");

  // A payout that already exists (and is not confirmed failed) is only looked up, never created again.
  if (row.payout_id && !FAILED.includes(String(row.payout_status || ""))) {
    const looked = await checkPayout({ id });
    return { ran: true, status: looked.status || row.refund_status, payoutId: row.payout_id, lookedUp: true };
  }

  // Claim the row. Exactly one request can win; a double click or a second admin loses.
  const confirmedFailed = row.refund_status === "failed" && FAILED.includes(String(row.payout_status || ""));
  const previous = Number(row.payout_attempts || 0);
  const attempt = confirmedFailed ? previous + 1 : Math.max(previous, 1);

  let claim;
  if (row.refund_status === "pending") {
    [claim] = await pool.execute(
      `UPDATE return_requests SET refund_status = 'processing', payout_status = 'initiating', payout_attempts = ?,
         refund_error = NULL, payout_failure_reason = NULL, payout_initiated_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
       WHERE id = ? AND refund_status = 'pending' AND payout_id IS NULL`,
      [attempt, id]
    );
  } else if (confirmedFailed) {
    [claim] = await pool.execute(
      `UPDATE return_requests SET refund_status = 'processing', payout_status = 'initiating', payout_attempts = ?,
         payout_id = NULL, payout_utr = NULL, refund_error = NULL, payout_failure_reason = NULL,
         payout_initiated_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
       WHERE id = ? AND refund_status = 'failed' AND payout_attempts = ?`,
      [attempt, id, previous]
    );
  } else if (row.refund_status === "processing" && !row.payout_id) {
    // An earlier attempt may have reached RazorpayX but we never heard back. Wait out the
    // in-flight window, then resume with the SAME key: RazorpayX returns the same payout.
    [claim] = await pool.execute(
      `UPDATE return_requests SET updated_at = UTC_TIMESTAMP(6)
       WHERE id = ? AND refund_status = 'processing' AND payout_id IS NULL
         AND TIMESTAMPDIFF(SECOND, updated_at, UTC_TIMESTAMP(6)) >= 60`,
      [id]
    );
  } else {
    throw fail(409, "This refund cannot be paid in its current state.", "INVALID_TRANSITION");
  }
  if (claim.affectedRows !== 1) return { ran: false, status: row.refund_status, reason: "in_flight" };

  const idempotencyKey = `kvk-return-${id}-${attempt}`;

  try {
    let contactId = row.payout_contact_id;
    if (!contactId) {
      const customer = firstRow(
        await pool
          .execute(
            `SELECT pr.email AS email, o.shipping_name AS name, o.shipping_phone AS phone
             FROM return_requests r
             LEFT JOIN orders o ON o.id = r.order_id
             LEFT JOIN profiles pr ON pr.id = r.user_id
             WHERE r.id = ? LIMIT 1`,
            [id]
          )
          .catch(() => [[{}]])
      );
      const contact = await razorpayx.createContact({
        name: customer && customer.name,
        email: customer && customer.email,
        phone: customer && customer.phone,
        referenceId: `ret-${id}`.slice(0, 40),
      });
      contactId = contact.id;
      await pool.execute("UPDATE return_requests SET payout_contact_id = ? WHERE id = ?", [contactId, id]);
    }

    let fundAccountId = row.payout_fund_account_id;
    if (!fundAccountId) {
      const fundAccount = await razorpayx.createUpiFundAccount({ contactId, upiId: row.refund_upi_id });
      fundAccountId = fundAccount.id;
      await pool.execute("UPDATE return_requests SET payout_fund_account_id = ? WHERE id = ?", [fundAccountId, id]);
    }

    const payout = await razorpayx.createPayout({
      fundAccountId,
      amountRupees: Number(row.refund_amount),
      referenceId: id,
      idempotencyKey,
      narration: "KOVENIK refund",
      notes: { return_id: id, order_id: String(row.order_id) },
    });

    // Our own create call never completes a refund by itself; it records what RazorpayX says
    // ("processed" is the only status that finishes it).
    await pool.execute(
      "UPDATE return_requests SET payout_id = ?, payout_status = ?, refund_error = NULL, updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
      [payout.id, String(payout.status || "processing").toLowerCase(), id]
    );
    const applied = await applyPayoutState({
      payoutId: payout.id,
      referenceId: id,
      status: payout.status,
      utr: payout.utr,
      failureReason: payout.status_details && payout.status_details.description,
      amountPaise: payout.amount,
    });
    return { ran: true, status: applied.status || "processing", payoutId: payout.id, attempt };
  } catch (error) {
    const code = error.razorpayStatus;
    const definitive = Number.isInteger(code) && code >= 400 && code < 500 && code !== 429;
    if (definitive) {
      // RazorpayX rejected the request: nothing was created, so this is a real failure
      // and the next try uses a new attempt number.
      const reason = short(error.message);
      await pool.execute(
        `UPDATE return_requests SET refund_status = 'failed', payout_status = 'creation_failed',
           payout_failure_reason = ?, refund_error = ?, updated_at = UTC_TIMESTAMP(6)
         WHERE id = ? AND refund_status = 'processing' AND payout_id IS NULL`,
        [reason, reason, id]
      );
      return { ran: true, status: "failed", error: reason };
    }
    // Unreachable / 5xx / timeout: the outcome is unknown. Stay "processing" (never
    // completed, never failed); a retry resumes with the same idempotency key.
    await pool.execute(
      "UPDATE return_requests SET refund_error = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND refund_status = 'processing'",
      [short("Could not confirm with RazorpayX: " + error.message), id]
    );
    return { ran: true, status: "processing", error: error.message, unknown: true };
  }
};

// Background read-back of payouts that are still in flight (a missed webhook never
// leaves a customer on "Processing" forever). Read-only on RazorpayX.
const autoSyncOnce = async ({ limit = 25, minAgeSeconds = 180 } = {}) => {
  const summary = { examined: 0, completed: 0, failed: 0, unchanged: 0 };
  if (!razorpayx.isConfigured()) return summary;
  const pool = await poolPromise;
  let rows;
  try {
    [rows] = await pool.execute(
      `SELECT id FROM return_requests
       WHERE refund_method = ? AND refund_status = 'processing' AND payout_id IS NOT NULL
         AND TIMESTAMPDIFF(SECOND, updated_at, UTC_TIMESTAMP(6)) >= ?
       ORDER BY updated_at ASC LIMIT ${Number(limit) || 25}`,
      [METHOD, minAgeSeconds]
    );
  } catch (error) {
    if (error.code === "ER_BAD_FIELD_ERROR" || error.code === "ER_NO_SUCH_TABLE") return summary;
    throw error;
  }
  for (const row of rows) {
    summary.examined += 1;
    const result = await checkPayout({ id: row.id });
    if (result.changed && result.status === "completed") summary.completed += 1;
    else if (result.changed && result.status === "failed") summary.failed += 1;
    else summary.unchanged += 1;
    if (result.changed) {
      try {
        await require("./return.service").afterRefundChange(row.id);
      } catch (_error) {
        // the e-mail / status follow-up retries on the next change; never break the sync
      }
    }
  }
  return summary;
};

module.exports = {
  METHOD,
  refundStatusFor,
  applyPayoutState,
  applyWebhookEvent,
  initiate,
  checkPayout,
  autoSyncOnce,
};
