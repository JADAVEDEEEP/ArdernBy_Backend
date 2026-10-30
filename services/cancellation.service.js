const { randomUUID } = require("crypto");
const { poolPromise } = require("../config/sql");
const audit = require("./audit.service");
const inventoryHistory = require("./inventory-history.service");
const orderService = require("./order.service");
const calc = require("./refund-calc.service");
const refundRunner = require("./refund-runner.service");
const notifications = require("./notification.service");
const reasons = require("../utils/reasons");
const paymentStatus = require("../utils/payment-status");
const paymentState = require("./payment-state.service");

// ==========================================
// ORDER CANCELLATION (full or by item / quantity)
//
// Who and when (checked here on the server, never only in the screen):
//   Pending / Confirmed / Processing  customer and admin
//   Packed                            admin only (dispatch has not started)
//   Shipped                           nobody: after delivery use a return
//   Delivered / Returned              use a return
//   Cancelled                         already done
//
// A cancellation removes whole units from order lines. Nothing in `orders` or
// `order_items` is rewritten; what was cancelled lives in order_cancellations /
// order_cancellation_items, and the refund is calculated by refund-calc.service
// (never taken from the browser).
//
// In one transaction, under a lock on the order row:
//   * the units are re-checked against what is still available,
//   * stock is restored for exactly the cancelled quantities (once; each movement
//     has a dedupe key),
//   * the cancellation and its items are recorded,
//   * if no units remain the order becomes Cancelled.
// AFTER the commit the refund is sent to Razorpay through refund-runner (claimed
// first, keyed, idempotent). "Completed" only when Razorpay says processed.
//
// Until admin_controls_phase3 is applied the old whole-order cancel keeps working.
// ==========================================

const CUSTOMER_STATUSES = ["pending", "confirmed", "processing"];
const ADMIN_STATUSES = [...CUSTOMER_STATUSES, "packed"];
const NOTE_MAX = 500;

const httpError = (statusCode, message, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

const isMissingTable = (error) =>
  Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);

const clean = (value, max) =>
  typeof value === "string"
    ? value
        .normalize("NFC")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

const lc = (value) => String(value || "").trim().toLowerCase();

const ORDER_COLUMNS = `id, user_id, order_number, status, payment_method, payment_status, payment_id,
  subtotal, shipping_amount, discount_amount, tax_amount, total_amount`;

// ---- rules ------------------------------------------------------------------

const eligibility = (order, isAdmin) => {
  const status = lc(order.status);
  if (status === "cancelled") {
    return { ok: false, code: "ALREADY_CANCELLED", message: "This order has already been cancelled." };
  }
  if (status === "cancellation requested") {
    return { ok: false, code: "CANCELLATION_PENDING", message: "This order already has a cancellation in progress." };
  }
  if (status === "shipped") {
    return {
      ok: false,
      code: "SHIPPED",
      message:
        "This order has already been shipped, so it can no longer be cancelled. Once it is delivered you can return items from your order page.",
    };
  }
  if (status === "delivered" || status === "returned") {
    return {
      ok: false,
      code: "DELIVERED",
      message: "Delivered orders cannot be cancelled. You can return items from your order page.",
    };
  }
  const allowed = isAdmin ? ADMIN_STATUSES : CUSTOMER_STATUSES;
  if (!allowed.includes(status)) {
    return {
      ok: false,
      code: "NOT_CANCELLABLE",
      message: "Sorry, this order can no longer be cancelled because it has moved beyond the processing stage.",
    };
  }
  return { ok: true, code: "OK", message: "" };
};

// The money the customer actually paid online (stock is taken for these and for COD).
const paidOnline = (order) =>
  lc(order.payment_method) === "online" &&
  paymentStatus.isHeld(order.payment_status) &&
  Boolean(order.payment_id);

const stockWasTaken = (order) =>
  !(lc(order.payment_method) === "online" && !paymentStatus.isCollected(order.payment_status));

const validateReason = ({ reasonCode, note, isAdmin }) => {
  const list = isAdmin ? reasons.ADMIN_CANCEL_REASONS : reasons.CUSTOMER_CANCEL_REASONS;
  if (typeof reasonCode !== "string" || !reasons.codes(list).includes(reasonCode)) {
    throw httpError(400, "Please choose a reason for the cancellation.", "REASON_REQUIRED");
  }
  const text = clean(note, NOTE_MAX);
  if (reasonCode === "other" && text.length < 5) {
    throw httpError(400, "Please explain the reason in a few words.", "REASON_NOTE_REQUIRED");
  }
  return { reasonCode, note: text };
};

// ---- transactions ----------------------------------------------------------------

const withTransaction = async (work) => {
  const pool = await poolPromise;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    throw error;
  } finally {
    connection.release();
  }
};

const engineAvailable = async (pool) => {
  try {
    await pool.execute("SELECT 1 FROM order_cancellations LIMIT 1");
    return true;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
};

const loadLines = async (executor, orderId) => {
  const [rows] = await executor.execute(
    "SELECT id, product_id, variant_id, product_name, product_image, size, color, quantity, unit_price FROM order_items WHERE order_id = ? ORDER BY created_at ASC, id ASC",
    [orderId]
  );
  return rows;
};

// What can still be cancelled on each line.
const availability = (lines, commitments) =>
  lines.map((line) => {
    const taken = calc.committedUnits(commitments, line.id, { all: true });
    return { line, taken, available: Math.max(Number(line.quantity) - taken, 0) };
  });

// Turns the request into picks. No items = everything still available.
const buildPicks = (rows, items) => {
  if (items === undefined || items === null) {
    const picks = rows
      .filter((row) => row.available > 0)
      .map((row) => ({ orderItemId: String(row.line.id), quantity: row.available, offset: row.taken }));
    if (picks.length === 0) throw httpError(409, "There is nothing left on this order to cancel.", "NOTHING_LEFT");
    return picks;
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, "Choose at least one item to cancel.", "NO_ITEMS");
  }
  const byId = new Map(rows.map((row) => [String(row.line.id), row]));
  const seen = new Set();
  return items.map((item) => {
    const id = typeof item?.orderItemId === "string" ? item.orderItemId.trim() : "";
    const quantity = Number(item?.quantity);
    const row = byId.get(id);
    if (!row) throw httpError(400, "One of the chosen items is not part of this order.", "UNKNOWN_ITEM");
    if (seen.has(id)) throw httpError(400, "The same item was chosen twice.", "DUPLICATE_ITEM");
    seen.add(id);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw httpError(400, "Each item needs a quantity of 1 or more.", "BAD_QUANTITY");
    }
    if (quantity > row.available) {
      throw httpError(
        409,
        row.available === 0
          ? `${row.line.product_name} has already been cancelled.`
          : `Only ${row.available} of ${row.line.product_name} can still be cancelled.`,
        "QUANTITY_UNAVAILABLE"
      );
    }
    return { orderItemId: id, quantity, offset: row.taken };
  });
};

// Shared by preview and cancel: what would be cancelled and refunded.
const plan = async (executor, order, isAdmin, items) => {
  const lines = await loadLines(executor, order.id);
  const commitments = await calc.loadCommitments(executor, order.id, lines);
  const rows = availability(lines, commitments);
  const picks = buildPicks(rows, items);

  const remainingAfter = rows.reduce((sum, row) => {
    const pick = picks.find((p) => p.orderItemId === String(row.line.id));
    return sum + row.available - (pick ? pick.quantity : 0);
  }, 0);
  const wholeRemaining = remainingAfter === 0;

  let breakdown = null;
  if (paidOnline(order)) {
    breakdown = calc.computeRefund({
      order,
      lines,
      picks,
      // Shipping goes back only when the last remaining items are cancelled.
      includeShipping: wholeRemaining,
      alreadyRefundedPaise: commitments.refundedPaise,
    });
  } else {
    // Nothing was collected online: still compute so the screen can show the value.
    try {
      breakdown = calc.computeRefund({ order, lines, picks, includeShipping: wholeRemaining });
    } catch (error) {
      breakdown = null;
    }
  }

  return { lines, rows, picks, wholeRemaining, breakdown, refundable: paidOnline(order) };
};

const lineSummary = (lines, picks) =>
  picks
    .map((pick) => {
      const line = lines.find((l) => String(l.id) === pick.orderItemId);
      return `${pick.quantity} × ${line ? line.product_name : "item"}`;
    })
    .join(", ");

const loadOrder = async (executor, orderId, ownerUserId, lock = false) => {
  const [rows] = await executor.execute(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ? ${ownerUserId ? "AND user_id = ?" : ""} LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
    ownerUserId ? [orderId, ownerUserId] : [orderId]
  );
  // Another customer's order looks like a missing one.
  if (!rows[0]) throw httpError(404, "Order not found.");
  return rows[0];
};

// ---- read side ---------------------------------------------------------------------

const historyFor = async (executor, orderId) => {
  try {
    const [rows] = await executor.execute(
      `SELECT id, initiated_by, reason_code, reason_note, whole_order, refund_amount, refund_status, refund_error,
              DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
       FROM order_cancellations WHERE order_id = ? ORDER BY created_at ASC`,
      [orderId]
    );
    return rows;
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
};

const getOptions = async ({ orderId, ownerUserId, isAdmin }) => {
  const pool = await poolPromise;
  const order = await loadOrder(pool, orderId, ownerUserId);
  const verdict = eligibility(order, isAdmin);
  const ready = await engineAvailable(pool);
  const lines = await loadLines(pool, order.id);
  const commitments = await calc.loadCommitments(pool, order.id, lines);
  const rows = availability(lines, commitments);

  const history = (await historyFor(pool, order.id)).map((h) => ({
    id: h.id,
    by: h.initiated_by,
    reason: reasons.label([...reasons.CUSTOMER_CANCEL_REASONS, ...reasons.ADMIN_CANCEL_REASONS], h.reason_code),
    note: h.reason_note,
    wholeOrder: Boolean(h.whole_order),
    refundAmount: h.refund_amount === null ? null : Number(h.refund_amount),
    at: h.created_at,
    // Customers only ever see "in progress" or "refunded".
    refund:
      h.refund_status === "completed"
        ? "refunded"
        : ["pending", "processing", "failed"].includes(h.refund_status)
          ? "in_progress"
          : null,
  }));

  const anyLeft = rows.some((row) => row.available > 0);
  const eligible = verdict.ok && anyLeft;

  return {
    eligible,
    code: eligible ? "OK" : verdict.ok ? "NOTHING_LEFT" : verdict.code,
    message: eligible ? "" : verdict.ok ? "Every item on this order has already been cancelled." : verdict.message,
    partialAvailable: ready,
    reasons: isAdmin ? reasons.ADMIN_CANCEL_REASONS : reasons.CUSTOMER_CANCEL_REASONS,
    paidOnline: paidOnline(order),
    items: rows.map((row) => ({
      orderItemId: row.line.id,
      name: row.line.product_name,
      image: row.line.product_image || null,
      size: row.line.size,
      color: row.line.color,
      quantity: Number(row.line.quantity),
      cancelledQuantity: row.taken,
      availableQuantity: row.available,
      unitPrice: Number(row.line.unit_price),
    })),
    history,
  };
};

const preview = async ({ orderId, ownerUserId, isAdmin, items }) => {
  const pool = await poolPromise;
  const order = await loadOrder(pool, orderId, ownerUserId);
  const verdict = eligibility(order, isAdmin);
  if (!verdict.ok) throw httpError(409, verdict.message, verdict.code);

  const result = await plan(pool, order, isAdmin, items);
  return {
    wholeOrder: result.wholeRemaining,
    refundable: result.refundable,
    breakdown: result.breakdown,
    // The customer is told the amount only when money was actually collected.
    amount: result.refundable && result.breakdown ? result.breakdown.final : 0,
  };
};

// ---- the cancellation itself ---------------------------------------------------------

const cancel = async ({ orderId, actor, isAdmin, ownerUserId, reasonCode, note, items }) => {
  const reason = validateReason({ reasonCode, note, isAdmin });
  const pool = await poolPromise;

  // Not migrated yet: the original whole-order cancel keeps working.
  if (!(await engineAvailable(pool))) {
    if (items !== undefined && items !== null) {
      throw httpError(503, "Cancelling individual items is not available yet. Please cancel the whole order.", "NOT_AVAILABLE");
    }
    const result = await orderService.cancelOrderById(orderId, {
      userId: isAdmin ? null : ownerUserId,
      reason: reason.note || reasons.label(isAdmin ? reasons.ADMIN_CANCEL_REASONS : reasons.CUSTOMER_CANCEL_REASONS, reason.reasonCode),
      actorId: actor.id,
    });
    await audit.record({
      actor,
      action: "order.cancel",
      resourceType: "order",
      resourceId: orderId,
      reason: `${reason.reasonCode}${reason.note ? ": " + reason.note : ""}`,
      after: { status: result.status, paymentStatus: result.paymentStatus, refundStatus: result.refundStatus, refundAmount: result.refundAmount, wholeOrder: true },
    });
    return { id: null, wholeOrder: true, status: "Cancelled", refundAmount: result.refundAmount || 0, refundStatus: null, legacy: true };
  }

  const cancellationId = randomUUID();

  const made = await withTransaction(async (connection) => {
    const order = await loadOrder(connection, orderId, isAdmin ? null : ownerUserId, true);
    const verdict = eligibility(order, isAdmin);
    if (!verdict.ok) throw httpError(409, verdict.message, verdict.code);

    const result = await plan(connection, order, isAdmin, items);
    const amountPaise = result.refundable && result.breakdown ? result.breakdown.finalPaise : 0;
    const taken = stockWasTaken(order);
    const byLine = new Map(result.lines.map((line) => [String(line.id), line]));
    const lineRefunds = new Map((result.breakdown?.lines || []).map((l) => [l.orderItemId, l.refund]));

    await connection.execute(
      `
        INSERT INTO order_cancellations
          (id, order_id, user_id, initiated_by, actor_id, reason_code, reason_note, whole_order,
           refund_amount, refund_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
      `,
      [
        cancellationId,
        order.id,
        order.user_id,
        isAdmin ? "admin" : "customer",
        actor.id,
        reason.reasonCode,
        reason.note || null,
        result.wholeRemaining ? 1 : 0,
        amountPaise > 0 ? calc.rupees(amountPaise) : null,
        amountPaise > 0 ? "pending" : "not_applicable",
      ]
    );

    for (const pick of result.picks) {
      const line = byLine.get(pick.orderItemId);
      await connection.execute(
        `INSERT INTO order_cancellation_items (id, cancellation_id, order_item_id, variant_id, quantity, line_refund)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), cancellationId, pick.orderItemId, line.variant_id || null, pick.quantity, lineRefunds.get(pick.orderItemId) ?? null]
      );

      // Stock goes back only for the cancelled quantity, and only if it was taken.
      if (taken && line.variant_id) {
        await connection.execute(
          `UPDATE product_variants SET inventory = inventory + ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?`,
          [pick.quantity, line.variant_id]
        );
        await inventoryHistory.recordVariantDelta(connection, {
          variantId: line.variant_id,
          delta: pick.quantity,
          reason: `Order ${order.order_number} cancelled - stock returned`,
          source: "order_cancelled",
          referenceType: "cancellation",
          referenceId: cancellationId,
          actorId: actor.id,
          dedupeKey: `order_cancelled:${cancellationId}:${pick.orderItemId}`,
        });
      }
    }

    if (result.wholeRemaining) {
      await connection.execute(
        "UPDATE orders SET status = 'Cancelled', payment_status = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
        [amountPaise > 0 ? "Refund Pending" : order.payment_status, order.id]
      );
    }

    return {
      order,
      wholeRemaining: result.wholeRemaining,
      amountPaise,
      items: lineSummary(result.lines, result.picks),
      picks: result.picks,
      breakdown: result.breakdown,
    };
  });

  await audit.record({
    actor,
    action: "order.cancel",
    resourceType: "order",
    resourceId: orderId,
    reason: `${reason.reasonCode}${reason.note ? ": " + reason.note : ""}`,
    after: {
      cancellationId,
      wholeOrder: made.wholeRemaining,
      items: made.picks,
      refundAmount: calc.rupees(made.amountPaise),
      initiatedBy: isAdmin ? "admin" : "customer",
    },
    dedupeKey: `order.cancel:${cancellationId}`,
  });

  await notifications.notifyUser({
    userId: made.order.user_id,
    dedupeKey: `cancel-confirmed:${cancellationId}`,
    template: "cancellation_confirmed",
    data: {
      orderNumber: made.order.order_number,
      whole: made.wholeRemaining,
      items: made.items,
      reason: reasons.label([...reasons.CUSTOMER_CANCEL_REASONS, ...reasons.ADMIN_CANCEL_REASONS], reason.reasonCode),
      refundAmount: calc.rupees(made.amountPaise),
    },
  });

  let refundStatus = made.amountPaise > 0 ? "pending" : "not_applicable";
  if (made.amountPaise > 0) {
    const outcome = await refundRunner.runRefund({
      table: "order_cancellations",
      id: cancellationId,
      order: made.order,
      amount: calc.rupees(made.amountPaise),
    });
    refundStatus = outcome.status || refundStatus;
    await afterRefundChange(cancellationId);
  }

  return {
    id: cancellationId,
    wholeOrder: made.wholeRemaining,
    status: made.wholeRemaining ? "Cancelled" : made.order.status,
    refundAmount: calc.rupees(made.amountPaise),
    refundStatus,
    breakdown: made.breakdown,
  };
};

// ---- after a refund moves: order payment state + e-mails ------------------------------------

// The order's payment status follows its refunds (see payment-state.service).
const syncOrderPayment = paymentState.syncOrderPayment;

const afterRefundChange = async (cancellationId) => {
  try {
    const pool = await poolPromise;
    const [rows] = await pool.execute(
      "SELECT order_id, user_id, refund_status, refund_amount, refund_id FROM order_cancellations WHERE id = ? LIMIT 1",
      [cancellationId]
    );
    const row = rows[0];
    if (!row) return;
    await syncOrderPayment(pool, row.order_id);

    const [orders] = await pool.execute("SELECT order_number FROM orders WHERE id = ? LIMIT 1", [row.order_id]);
    const data = { orderNumber: orders[0]?.order_number, amount: Number(row.refund_amount || 0) };
    const template = { processing: "refund_initiated", completed: "refund_completed", failed: "refund_failed" }[row.refund_status];
    if (template) {
      await notifications.notifyUser({
        userId: row.user_id,
        dedupeKey: `${template}:c:${cancellationId}`,
        template,
        data,
      });
    }
  } catch (error) {
    console.error("afterRefundChange (cancellation) failed:", error.code || error.message);
  }
};

// ---- admin: retry ----------------------------------------------------------------------------

const retryRefund = async ({ id, actor }) => {
  const pool = await poolPromise;
  const [rows] = await pool.execute(
    "SELECT id, order_id, refund_amount, refund_status FROM order_cancellations WHERE id = ? LIMIT 1",
    [id]
  );
  const row = rows[0];
  if (!row) throw httpError(404, "Cancellation not found.");
  if (["completed", "not_applicable"].includes(row.refund_status)) {
    throw httpError(409, "This refund does not need a retry.", "INVALID_TRANSITION");
  }

  const [orders] = await pool.execute("SELECT id, payment_id FROM orders WHERE id = ? LIMIT 1", [row.order_id]);
  const outcome = await refundRunner.runRefund({
    table: "order_cancellations",
    id,
    order: orders[0],
    amount: Number(row.refund_amount),
  });
  await afterRefundChange(id);

  await audit.record({
    actor,
    action: "order.refund_retry",
    resourceType: "order",
    resourceId: row.order_id,
    outcome: outcome.status === "failed" ? "failure" : "success",
    before: { refund: row.refund_status },
    after: { refund: outcome.status, amount: Number(row.refund_amount), reason: outcome.reason || outcome.error || null },
  });

  if (outcome.reason === "in_flight") {
    throw httpError(409, "A refund attempt is already in progress. Wait a minute, then check again.", "IN_FLIGHT");
  }
  return { id, refundStatus: outcome.status, refundAmount: Number(row.refund_amount) };
};

// Retries every unfinished refund of an order (what the admin "Retry refund" button asks for).
const retryForOrder = async ({ orderId, actor }) => {
  const pool = await poolPromise;
  let rows;
  try {
    [rows] = await pool.execute(
      "SELECT id FROM order_cancellations WHERE order_id = ? AND refund_status IN ('pending', 'processing', 'failed') ORDER BY created_at ASC",
      [orderId]
    );
  } catch (error) {
    if (isMissingTable(error)) return null; // not migrated: the original retry applies
    throw error;
  }
  if (rows.length === 0) return null;
  const results = [];
  for (const row of rows) results.push(await retryRefund({ id: row.id, actor }));
  return results;
};

module.exports = {
  eligibility,
  getOptions,
  preview,
  cancel,
  retryRefund,
  retryForOrder,
  afterRefundChange,
  engineAvailable,
  paidOnline,
  stockWasTaken,
};
