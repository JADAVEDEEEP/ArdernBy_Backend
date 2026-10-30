const { poolPromise } = require("../config/sql");
const audit = require("./audit.service");
const refundRunner = require("./refund-runner.service");
const cancellationService = require("./cancellation.service");
const returnService = require("./return.service");
const calc = require("./refund-calc.service");
const reasons = require("../utils/reasons");

// ==========================================
// REFUND STATUS: CHECK, HISTORY, AUTOMATIC SYNC
//
// Razorpay can accept a refund first and finish ("processed") later; the webhook that
// tells us is not always delivered (local server, a backend without the webhook, an
// outage). So a refund KOVENIK holds as "processing" is also looked up on demand
// (admin button) and automatically (a periodic sweep).
//
// Nothing here can send money: a check only LISTS the payment's refunds at Razorpay
// (refund-runner.checkStatus) and moves our record forward (processing -> completed /
// failed). It never calls the refund-create API, so repeating it any number of times,
// from any number of servers, cannot cause a second refund.
// ==========================================

const TABLE_OF = { cancellation: "order_cancellations", return: "return_requests" };

const isMissingTable = (error) => Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);

const httpError = (statusCode, message, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

const afterChange = async (kind, id) => {
  if (kind === "cancellation") return cancellationService.afterRefundChange(id);
  return returnService.afterRefundChange(id);
};

// One refund: look it up at Razorpay, then do the follow-ups (order payment status, e-mail).
const checkOne = async ({ kind, id }) => {
  const result = await refundRunner.checkStatus({ table: TABLE_OF[kind], id });
  if (result.changed) await afterChange(kind, id);
  return { kind, id, ...result };
};

// ---- history for one order ---------------------------------------------------------------

const STATUS_LABEL = {
  not_applicable: "No refund needed",
  pending: "Not sent to Razorpay yet",
  processing: "Processing at Razorpay",
  completed: "Refunded",
  failed: "Failed - retry needed",
  manual_done: "Paid back manually",
};

const iso = (value) => (value ? new Date(value).toISOString() : null);

const entryFor = (kind, row, items) => {
  const amount = row.refund_amount === null || row.refund_amount === undefined ? null : Number(row.refund_amount);
  const status = row.refund_status || (kind === "return" ? null : "not_applicable");
  return {
    kind,
    id: row.id,
    at: iso(row.created_at),
    by: kind === "cancellation" ? row.initiated_by : "customer return",
    reason:
      kind === "cancellation"
        ? reasons.label([...reasons.CUSTOMER_CANCEL_REASONS, ...reasons.ADMIN_CANCEL_REASONS], row.reason_code)
        : reasons.label(reasons.RETURN_REASONS, row.reason_code),
    wholeOrder: kind === "cancellation" ? Boolean(row.whole_order) : null,
    returnStatus: kind === "return" ? row.status : null,
    items,
    amount,
    status,
    statusLabel: STATUS_LABEL[status] || (status ? status : "Refund not decided yet"),
    method: row.refund_method || (kind === "cancellation" && amount ? "razorpay" : null),
    refundId: row.refund_id || null,
    reference: row.refund_reference || null,
    error: row.refund_error || null,
    completedAt: iso(row.refund_completed_at),
    // The check only reads Razorpay: offered whenever Razorpay may know more than we do.
    canCheck: ["processing", "failed"].includes(status) && (kind === "cancellation" || row.refund_method === "razorpay"),
    canRetry: ["pending", "failed"].includes(status) && (kind === "cancellation" || row.refund_method === "razorpay"),
  };
};

const historyForOrder = async (orderId) => {
  const pool = await poolPromise;
  const [orders] = await pool.execute(
    "SELECT id, order_number, status, payment_method, payment_status, total_amount, payment_id FROM orders WHERE id = ? LIMIT 1",
    [orderId]
  );
  const order = orders[0];
  if (!order) throw httpError(404, "Order not found.");

  const entries = [];

  try {
    const [cancels] = await pool.execute(
      "SELECT * FROM order_cancellations WHERE order_id = ? ORDER BY created_at ASC, id ASC",
      [orderId]
    );
    for (const row of cancels) {
      const [items] = await pool.execute(
        `SELECT oi.product_name AS name, c.quantity
         FROM order_cancellation_items c INNER JOIN order_items oi ON oi.id COLLATE utf8mb4_unicode_ci = c.order_item_id
         WHERE c.cancellation_id = ?`,
        [row.id]
      );
      entries.push(entryFor("cancellation", row, items.map((i) => ({ name: i.name, quantity: Number(i.quantity) }))));
    }
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }

  try {
    const [returns] = await pool.execute(
      "SELECT * FROM return_requests WHERE order_id = ? AND status <> 'Rejected' ORDER BY created_at ASC, id ASC",
      [orderId]
    );
    for (const row of returns) {
      const [items] = await pool.execute(
        `SELECT oi.product_name AS name, i.quantity
         FROM return_request_items i INNER JOIN order_items oi ON oi.id COLLATE utf8mb4_unicode_ci = i.order_item_id
         WHERE i.return_id = ?`,
        [row.id]
      );
      // Only returns that have reached a refund decision belong in the money history.
      if (row.refund_status) entries.push(entryFor("return", row, items.map((i) => ({ name: i.name, quantity: Number(i.quantity) }))));
    }
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }

  entries.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const sum = (pick) => entries.filter(pick).reduce((s, e) => s + calc.toPaise(e.amount || 0), 0);
  const paidPaise = ["paid", "partially refunded", "refund pending", "refunded"].includes(String(order.payment_status).toLowerCase())
    ? calc.toPaise(order.total_amount)
    : 0;
  const confirmedPaise = sum((e) => ["completed", "manual_done"].includes(e.status));
  const inProgressPaise = sum((e) => ["pending", "processing", "failed"].includes(e.status));

  return {
    order: {
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      paymentMethod: order.payment_method,
      paymentStatus: order.payment_status,
      total: Number(order.total_amount),
    },
    totals: {
      paid: calc.rupees(paidPaise),
      refundedConfirmed: calc.rupees(confirmedPaise),
      inProgress: calc.rupees(inProgressPaise),
      stillHeld: calc.rupees(Math.max(paidPaise - confirmedPaise, 0)),
    },
    entries,
    canCheck: entries.some((e) => e.canCheck),
    canRetry: entries.some((e) => e.canRetry),
  };
};

// ---- admin button -------------------------------------------------------------------------

// Checks every unfinished Razorpay refund of an order (cancellations and returns).
const checkOrder = async ({ orderId, actor }) => {
  const pool = await poolPromise;
  const targets = [];
  for (const [kind, table] of Object.entries(TABLE_OF)) {
    try {
      const [rows] = await pool.execute(
        `SELECT id, refund_status FROM ${table} WHERE order_id = ? AND refund_status IN ('processing', 'failed') ORDER BY created_at ASC`,
        [orderId]
      );
      for (const row of rows) targets.push({ kind, id: row.id, before: row.refund_status });
    } catch (error) {
      if (!isMissingTable(error)) throw error;
    }
  }

  const results = [];
  for (const target of targets) {
    const result = await checkOne(target);
    results.push({ ...result, before: target.before });
  }

  await audit.record({
    actor,
    action: "order.refund_check",
    resourceType: "order",
    resourceId: orderId,
    after: {
      checked: results.length,
      results: results.map((r) => ({ kind: r.kind, id: r.id, before: r.before, razorpay: r.razorpayStatus || r.reason || null, now: r.status || null })),
    },
  });

  return { checked: results.length, results };
};

// The Returns page asks about one return; its order's other refunds are checked with it.
const checkReturn = async ({ id, actor }) => {
  const pool = await poolPromise;
  const [rows] = await pool.execute("SELECT order_id FROM return_requests WHERE id = ? LIMIT 1", [id]);
  if (!rows[0]) throw httpError(404, "Return request not found.");
  return checkOrder({ orderId: rows[0].order_id, actor });
};

// ---- automatic sweep -----------------------------------------------------------------------

// Looks up every refund that has been "processing" for a little while. Each row is checked
// on its own; one failure never stops the others.
const autoSyncOnce = async ({ limit = 50, minAgeSeconds = 120 } = {}) => {
  const pool = await poolPromise;
  const summary = { examined: 0, completed: 0, failed: 0, unchanged: 0, unreadable: 0 };

  for (const [kind, table] of Object.entries(TABLE_OF)) {
    let rows;
    try {
      [rows] = await pool.execute(
        `SELECT id FROM ${table}
         WHERE refund_status = 'processing' AND TIMESTAMPDIFF(SECOND, updated_at, UTC_TIMESTAMP(6)) >= ?
         ORDER BY updated_at ASC LIMIT ${Number(limit) || 50}`,
        [minAgeSeconds]
      );
    } catch (error) {
      if (isMissingTable(error)) continue;
      throw error;
    }

    for (const row of rows) {
      summary.examined += 1;
      try {
        const result = await checkOne({ kind, id: row.id });
        if (result.changed && result.status === "completed") summary.completed += 1;
        else if (result.changed && result.status === "failed") summary.failed += 1;
        else if (result.checked === false && result.reason === "razorpay_unreadable") summary.unreadable += 1;
        else summary.unchanged += 1;
      } catch (error) {
        summary.unreadable += 1;
        console.error("Refund auto-sync failed for", kind, row.id, "-", error.code || error.message);
      }
    }
  }
  return summary;
};

module.exports = { checkOne, checkOrder, checkReturn, historyForOrder, autoSyncOnce };
