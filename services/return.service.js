const { randomUUID } = require("crypto");
const { poolPromise } = require("../config/sql");
const audit = require("./audit.service");
const inventoryHistory = require("./inventory-history.service");
const calc = require("./refund-calc.service");
const refundRunner = require("./refund-runner.service");
const notifications = require("./notification.service");
const reasons = require("../utils/reasons");
const paymentStatus = require("../utils/payment-status");
const paymentState = require("./payment-state.service");
const deliveryDate = require("./delivery-date.service");

// ==========================================
// RETURNS
//
//   Requested -> Approved | Rejected
//   Approved  -> Shipped (customer says it is on its way, optional tracking no.)
//             -> Received (goods arrived; may be recorded without Shipped)
//   Shipped   -> Received
//   Received  -> Inspected (every returned item checked, one by one)
//   Inspected -> Completed (only when the refund is completed, or nothing is refundable)
//   Rejected / Completed are final.
//
// Each step is validated (an invalid jump is a 409), recorded in
// return_status_history with who did it, and e-mailed to the customer once.
//
// Money and stock follow the INSPECTION, not the approval:
//   * stock is restored per item, only for items the admin inspected as resalable
//     (or explicitly authorised), once (restocked_at + a movement dedupe key);
//   * the refund is calculated by the server from the refundable items
//     (refund-calc.service): item price - its share of the discount + its share of
//     GST, shipping NOT refunded on a return, an optional admin deduction with a
//     reason can only lower it, and it can never exceed what was paid.
//   * online payments are refunded through Razorpay (refund-runner, keyed and
//     idempotent); cash on delivery needs a manual payout method and reference.
//
// A customer may return different items of one order in separate requests. The
// order row is locked while a request is saved, so two requests can never claim
// the same unit.
// ==========================================

const REASON_NOTE_MAX = 1000;
const MAX_ITEM_LINES = 100;
const TRACKING_MAX = 100;

const httpError = (statusCode, message, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

const cleanText = (value, max) =>
  typeof value === "string"
    ? value
        .normalize("NFC")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

const TABLE_MISSING = "Returns are not available yet. The database update has not been applied.";
const isMissingTable = (error) =>
  Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);

const wrapMissing = async (work) => {
  try {
    return await work();
  } catch (error) {
    if (isMissingTable(error)) throw httpError(503, TABLE_MISSING);
    throw error;
  }
};

const TRANSITIONS = {
  Requested: ["Approved", "Rejected"],
  Approved: ["Shipped", "Received"],
  Shipped: ["Received"],
  Received: ["Inspected"],
  Inspected: ["Completed"],
  Rejected: [],
  Completed: [],
};

const assertTransition = (from, to) => {
  if (!(TRANSITIONS[from] || []).includes(to)) {
    throw httpError(
      409,
      `A return that is ${String(from).toLowerCase()} cannot be moved to ${String(to).toLowerCase()}.`,
      "INVALID_TRANSITION"
    );
  }
};

// ---- policy ------------------------------------------------------------------

const getPolicy = async (pool) => {
  try {
    const [rows] = await pool.execute("SELECT value FROM store_settings WHERE section = 'returns' LIMIT 1");
    const stored = rows[0] ? JSON.parse(rows[0].value) : {};
    const windowDays = Number(stored.windowDays);
    return {
      enabled: stored.enabled === true && Number.isInteger(windowDays) && windowDays > 0,
      windowDays: Number.isInteger(windowDays) && windowDays > 0 ? windowDays : 0,
    };
  } catch {
    return { enabled: false, windowDays: 0 };
  }
};

// ---- transactions and history ------------------------------------------------------

const withConnection = async (work) => {
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

const lockReturn = async (connection, id) => {
  const [rows] = await connection.execute("SELECT * FROM return_requests WHERE id = ? LIMIT 1 FOR UPDATE", [id]);
  if (!rows[0]) throw httpError(404, "Return request not found.");
  return rows[0];
};

const recordHistory = async (executor, returnId, from, to, actor, note) => {
  await executor.execute(
    `INSERT INTO return_status_history (id, return_id, from_status, to_status, actor_id, actor_role, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
    [randomUUID(), returnId, from, to, actor?.id || null, actor?.role || null, note ? String(note).slice(0, 500) : null]
  );
};

// Moves the status inside a transaction, guarded so only one caller wins.
const moveStatus = async (connection, request, to, actor, note, extraSet = "", extraParams = []) => {
  assertTransition(request.status, to);
  const [updated] = await connection.execute(
    `UPDATE return_requests SET status = ?, updated_at = UTC_TIMESTAMP(6)${extraSet ? ", " + extraSet : ""}
     WHERE id = ? AND status = ?`,
    [to, ...extraParams, request.id, request.status]
  );
  if (updated.affectedRows !== 1) {
    throw httpError(409, "This return was just changed by someone else. Refresh and try again.", "CHANGED");
  }
  await recordHistory(connection, request.id, request.status, to, actor, note);
};

// ---- order lines, items -----------------------------------------------------------------

const ORDER_COLUMNS = `id, user_id, order_number, status, payment_method, payment_status, payment_id,
  subtotal, shipping_amount, discount_amount, tax_amount, total_amount`;

const loadLines = async (executor, orderId) => {
  const [rows] = await executor.execute(
    "SELECT id, product_id, variant_id, product_name, product_image, size, color, quantity, unit_price FROM order_items WHERE order_id = ? ORDER BY created_at ASC, id ASC",
    [orderId]
  );
  return rows;
};

const loadReturnItems = async (executor, returnId) => {
  const [rows] = await executor.execute(
    `SELECT id, order_item_id, product_id, variant_id, quantity, inspection_result, inspection_note,
            refundable, restock, restock_authorized, restocked_at, line_refund
     FROM return_request_items WHERE return_id = ?`,
    [returnId]
  );
  return rows;
};

const loadOrder = async (executor, orderId, lock = false) => {
  const [rows] = await executor.execute(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ? LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
    [orderId]
  );
  return rows[0] || null;
};

const shapeItem = (row, line) => ({
  id: row.id || null,
  orderItemId: row.order_item_id,
  name: line?.product_name || "",
  image: line?.product_image || null,
  size: line?.size || "",
  color: line?.color || "",
  quantity: Number(row.quantity),
  orderedQuantity: line ? Number(line.quantity) : Number(row.quantity),
  unitPrice: line ? Number(line.unit_price) : 0,
  inspection: row.inspection_result
    ? {
        result: row.inspection_result,
        label: reasons.label(reasons.INSPECTION_RESULTS, row.inspection_result),
        note: row.inspection_note,
        refundable: Boolean(row.refundable),
        restock: Boolean(row.restock),
        restockAuthorized: Boolean(row.restock_authorized),
        restocked: Boolean(row.restocked_at),
        lineRefund: row.line_refund === null || row.line_refund === undefined ? null : Number(row.line_refund),
      }
    : null,
});

// ---- customer: request ------------------------------------------------------------------


const eligibility = (policy, order, anyUnitLeft) => {
  if (!policy.enabled) {
    return { ok: false, code: "RETURNS_CLOSED", message: "Returns are not open right now. Please contact support." };
  }
  if (!same(order.status, "Delivered")) {
    return { ok: false, code: "NOT_DELIVERED", message: "Only delivered orders can be returned." };
  }
  // The window starts when the order was marked Delivered (order_delivery_log;
  // orders delivered before that was recorded use their last update time).
  if (Number(order.age_seconds) > policy.windowDays * 24 * 60 * 60) {
    return { ok: false, code: "WINDOW_ENDED", message: `The ${policy.windowDays}-day return window for this order has ended.` };
  }
  if (!anyUnitLeft) {
    return { ok: false, code: "ALL_REQUESTED", message: "Every item on this order has already been returned, cancelled or is part of a return request." };
  }
  return { ok: true, code: "OK", message: "" };
};

const parseItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) throw httpError(400, "Choose at least one item to return.", "NO_ITEMS");
  if (items.length > MAX_ITEM_LINES) throw httpError(400, "Too many items.");
  const seen = new Set();
  return items.map((item) => {
    const orderItemId = typeof item?.orderItemId === "string" ? item.orderItemId.trim() : "";
    const quantity = Number(item?.quantity);
    if (!orderItemId || orderItemId.length > 64) throw httpError(400, "Invalid item.");
    if (!Number.isInteger(quantity) || quantity < 1) throw httpError(400, "Each item needs a quantity of 1 or more.");
    if (seen.has(orderItemId)) throw httpError(400, "The same item was chosen twice.");
    seen.add(orderItemId);
    return { orderItemId, quantity };
  });
};

const validateReason = ({ reasonCode, description }) => {
  if (typeof reasonCode !== "string" || !reasons.codes(reasons.RETURN_REASONS).includes(reasonCode)) {
    throw httpError(400, "Please choose a reason for the return.", "REASON_REQUIRED");
  }
  const text = cleanText(description, REASON_NOTE_MAX);
  if (reasonCode === "other" && text.length < 5) {
    throw httpError(400, "Please explain the reason in a few words.", "REASON_NOTE_REQUIRED");
  }
  return { reasonCode, text };
};

const availabilityRows = (lines, commitments) =>
  lines.map((line) => {
    const taken = calc.committedUnits(commitments, line.id, { all: true });
    return { line, taken, available: Math.max(Number(line.quantity) - taken, 0) };
  });

const picksFor = (rows, chosen) => {
  const byId = new Map(rows.map((row) => [String(row.line.id), row]));
  return chosen.map((pick) => {
    const row = byId.get(pick.orderItemId);
    if (!row) throw httpError(400, "One of the chosen items is not part of this order.", "UNKNOWN_ITEM");
    if (pick.quantity > row.available) {
      throw httpError(
        409,
        row.available === 0
          ? `${row.line.product_name} has already been returned, cancelled or is part of another return.`
          : `Only ${row.available} of ${row.line.product_name} can still be returned.`,
        "QUANTITY_UNAVAILABLE"
      );
    }
    return { orderItemId: pick.orderItemId, quantity: pick.quantity, offset: row.taken };
  });
};

const createRequest = async ({ userId, orderId, reasonCode, description, items, actor }) => {
  const reason = validateReason({ reasonCode, description });
  if (typeof orderId !== "string" || !orderId || orderId.length > 64) throw httpError(400, "Invalid order.");
  const chosen = parseItems(items);

  return wrapMissing(async () => {
    const pool = await poolPromise;
    const policy = await getPolicy(pool);
    const id = randomUUID();
    const label = reasons.label(reasons.RETURN_REASONS, reason.reasonCode);

    const saved = await withConnection(async (connection) => {
      // The order row is locked: two requests for the same units are served one after the other.
      const [orders] = await connection.execute(
        `SELECT ${ORDER_COLUMNS}, ${await deliveryDate.ageSql(connection)} FROM orders WHERE id = ? AND user_id = ? LIMIT 1 FOR UPDATE`,
        [orderId, userId]
      );
      const order = orders[0];
      if (!order) throw httpError(404, "Order not found.");

      const lines = await loadLines(connection, orderId);
      const commitments = await calc.loadCommitments(connection, orderId, lines);
      const rows = availabilityRows(lines, commitments);

      const verdict = eligibility(policy, order, rows.some((row) => row.available > 0));
      if (!verdict.ok) throw httpError(409, verdict.message, verdict.code);

      const picks = picksFor(rows, chosen);
      const byId = new Map(lines.map((line) => [String(line.id), line]));

      await connection.execute(
        `
          INSERT INTO return_requests
            (id, order_id, user_id, status, customer_reason, reason_code, description, created_at, updated_at)
          VALUES (?, ?, ?, 'Requested', ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
        `,
        [id, orderId, userId, (reason.text ? `${label}: ${reason.text}` : label).slice(0, 500), reason.reasonCode, reason.text || null]
      );
      for (const pick of picks) {
        const line = byId.get(pick.orderItemId);
        await connection.execute(
          `INSERT INTO return_request_items (id, return_id, order_item_id, product_id, variant_id, quantity)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [randomUUID(), id, pick.orderItemId, line.product_id || null, line.variant_id || null, pick.quantity]
        );
      }
      await recordHistory(connection, id, null, "Requested", actor, label);
      return { order, picks, lines };
    });

    await audit.record({
      actor,
      action: "return.request",
      resourceType: "return",
      resourceId: id,
      after: { orderId, status: "Requested", reason: reason.reasonCode, items: saved.picks.map((p) => ({ orderItemId: p.orderItemId, quantity: p.quantity })) },
      dedupeKey: `return.request:${id}`,
    });
    await notifications.notifyUser({
      userId,
      dedupeKey: `return-submitted:${id}`,
      template: "return_submitted",
      data: {
        orderNumber: saved.order.order_number,
        items: saved.picks
          .map((p) => `${p.quantity} × ${saved.lines.find((l) => String(l.id) === p.orderItemId)?.product_name || "item"}`)
          .join(", "),
      },
    });

    return { id, orderId, status: "Requested" };
  });
};

// What a refund would be if these items came back in good order (an ESTIMATE shown
// before submitting; the real figure is decided after inspection).
const preview = async ({ userId, orderId, items }) =>
  wrapMissing(async () => {
    const chosen = parseItems(items);
    const pool = await poolPromise;
    const [orders] = await pool.execute(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ? AND user_id = ? LIMIT 1`, [orderId, userId]);
    if (!orders[0]) throw httpError(404, "Order not found.");
    const lines = await loadLines(pool, orderId);
    const commitments = await calc.loadCommitments(pool, orderId, lines);
    const picks = picksFor(availabilityRows(lines, commitments), chosen);
    const paid = paymentStatus.isHeld(orders[0].payment_status);
    const breakdown = calc.computeRefund({
      order: orders[0],
      lines,
      picks,
      includeShipping: false,
      alreadyRefundedPaise: commitments.refundedPaise,
    });
    return { estimate: paid ? breakdown.final : 0, breakdown: paid ? breakdown : null, shippingRefunded: false };
  });

// ---- customer: view ---------------------------------------------------------------------

const CUSTOMER_STATUS = {
  Requested: { label: "Pending", note: "We have your request and will review it shortly." },
  Approved: { label: "Approved", note: "Your return is approved. Please send the item(s) back to us, then tap \"I have sent the items\" on this page." },
  Shipped: { label: "On its way back", note: "Thank you. We are waiting for your parcel to arrive." },
  Received: { label: "Received", note: "We have your parcel and are checking the item(s)." },
  Inspected: { label: "Checked", note: "We finished checking your item(s) and are preparing your refund." },
  Completed: { label: "Completed", note: "Your return is complete." },
  Rejected: { label: "Rejected", note: "We are sorry — this return could not be accepted." },
};

const customerRefund = (row) => {
  if (!["Inspected", "Completed"].includes(row.status)) return null;
  switch (row.refund_status) {
    case "completed":
      return { state: "refunded", amount: money(row.refund_amount) };
    case "processing":
    case "pending":
    case "failed": // a failed refund is our problem to retry; the customer sees "in progress"
      return { state: "in_progress", amount: money(row.refund_amount) };
    default:
      return row.status === "Completed" ? { state: "none", amount: 0 } : null;
  }
};

const shapeCustomerReturn = (row, itemRows, lines, history) => {
  const status = CUSTOMER_STATUS[row.status] || { label: row.status, note: "" };
  const byLine = new Map(lines.map((line) => [String(line.id), line]));
  return {
    id: row.id,
    status: row.status,
    customerStatus: status.label,
    note: status.note,
    reason: row.customer_reason,
    decisionReason: row.status === "Rejected" ? row.decision_reason : null,
    requestedAt: row.created_iso || null,
    trackingReference: row.tracking_reference || null,
    refund: customerRefund(row),
    canMarkShipped: row.status === "Approved",
    items: itemRows.map((item) => {
      const shaped = shapeItem(item, byLine.get(String(item.order_item_id)));
      return {
        orderItemId: shaped.orderItemId,
        name: shaped.name,
        size: shaped.size,
        color: shaped.color,
        quantity: shaped.quantity,
        // Customers learn the result of the check, not internal notes.
        outcome: shaped.inspection ? shaped.inspection.label : null,
      };
    }),
    timeline: history.map((h) => ({
      status: h.to_status,
      label: (CUSTOMER_STATUS[h.to_status] || { label: h.to_status }).label,
      at: h.created_iso,
    })),
  };
};

const RETURN_SELECT = `*, DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_iso,
  DATE_FORMAT(decided_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS decided_iso,
  DATE_FORMAT(received_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS received_iso,
  DATE_FORMAT(shipped_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS shipped_iso,
  DATE_FORMAT(inspected_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS inspected_iso,
  DATE_FORMAT(completed_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS completed_iso`;

const loadHistory = async (executor, returnIds) => {
  if (returnIds.length === 0) return new Map();
  const [rows] = await executor.execute(
    `SELECT return_id, from_status, to_status, actor_id, actor_role, note,
            DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_iso
     FROM return_status_history WHERE return_id IN (${returnIds.map(() => "?").join(", ")})
     ORDER BY created_at ASC, id ASC`,
    returnIds
  );
  const byReturn = new Map();
  for (const row of rows) {
    if (!byReturn.has(row.return_id)) byReturn.set(row.return_id, []);
    byReturn.get(row.return_id).push(row);
  }
  return byReturn;
};

const getForCustomer = async ({ userId, orderId }) =>
  wrapMissing(async () => {
    const pool = await poolPromise;
    const policy = await getPolicy(pool);

    const [orders] = await pool.execute(
      `SELECT ${ORDER_COLUMNS}, ${await deliveryDate.ageSql(pool)} FROM orders WHERE id = ? AND user_id = ? LIMIT 1`,
      [orderId, userId]
    );
    const order = orders[0];
    if (!order) throw httpError(404, "Order not found.");

    const lines = await loadLines(pool, orderId);
    const commitments = await calc.loadCommitments(pool, orderId, lines);
    const rows = availabilityRows(lines, commitments);
    const verdict = eligibility(policy, order, rows.some((row) => row.available > 0));

    const [returns] = await pool.execute(
      `SELECT ${RETURN_SELECT} FROM return_requests WHERE order_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC`,
      [orderId, userId]
    );
    const history = await loadHistory(pool, returns.map((r) => r.id));
    const requests = [];
    for (const row of returns) {
      requests.push(shapeCustomerReturn(row, await loadReturnItems(pool, row.id), lines, history.get(row.id) || []));
    }

    const secondsLeft = policy.enabled ? policy.windowDays * 86400 - Number(order.age_seconds) : 0;

    return {
      policy,
      eligible: verdict.ok,
      reason: verdict.ok ? null : verdict.code,
      message: verdict.ok ? "" : verdict.message,
      daysLeft: verdict.ok ? Math.max(Math.ceil(secondsLeft / 86400), 0) : null,
      reasons: reasons.RETURN_REASONS,
      items: verdict.ok
        ? rows
            .filter((row) => row.available > 0)
            .map((row) => ({
              orderItemId: row.line.id,
              name: row.line.product_name,
              image: row.line.product_image || null,
              size: row.line.size,
              color: row.line.color,
              quantity: row.available,
              orderedQuantity: Number(row.line.quantity),
              unitPrice: Number(row.line.unit_price),
            }))
        : [],
      requests,
      request: requests[0] || null,
    };
  });

// ---- admin: read --------------------------------------------------------------------------

const shapeAdminReturn = (row, order, customer, lines, itemRows, history, commitments) => {
  const byLine = new Map(lines.map((line) => [String(line.id), line]));
  const items = itemRows.map((item) => shapeItem(item, byLine.get(String(item.order_item_id))));
  const paid = order ? paymentStatus.isCollected(order.payment_status) : false;

  // What the server would refund for the items currently marked refundable
  // (or for all of them, before inspection), so the admin sees the breakdown first.
  let refundPreview = null;
  if (order && ["Received", "Inspected"].includes(row.status) && commitments && row.refund_status == null) {
    try {
      const refundable = itemRows.filter((i) => (row.status === "Inspected" ? i.refundable : true));
      if (refundable.length > 0) {
        refundPreview = calc.computeRefund({
          order,
          lines,
          picks: refundable.map((i) => ({
            orderItemId: String(i.order_item_id),
            quantity: Number(i.quantity),
            offset: calc.committedUnits(commitments, i.order_item_id, { beforeReturnId: row.id }),
          })),
          includeShipping: false,
          alreadyRefundedPaise: commitments.refundedPaise,
        });
      }
    } catch (error) {
      refundPreview = { error: error.message };
    }
  }

  return {
    id: row.id,
    orderId: row.order_id,
    orderNumber: order?.order_number || null,
    status: row.status,
    reasonCode: row.reason_code,
    reasonLabel: row.reason_code ? reasons.label(reasons.RETURN_REASONS, row.reason_code) : null,
    customerReason: row.customer_reason,
    description: row.description,
    decisionReason: row.decision_reason,
    trackingReference: row.tracking_reference,
    requestedAt: row.created_iso || null,
    decidedAt: row.decided_iso || null,
    shippedAt: row.shipped_iso || null,
    receivedAt: row.received_iso || null,
    inspectedAt: row.inspected_iso || null,
    completedAt: row.completed_iso || null,
    items,
    order: order
      ? {
          status: order.status,
          paymentMethod: order.payment_method,
          paymentStatus: order.payment_status,
          total: Number(order.total_amount),
          paidOnline: same(order.payment_method, "online") && paid,
          paidCod: same(order.payment_method, "cod") && paid,
        }
      : null,
    customer: customer ? { name: customer.full_name || null, email: customer.email } : null,
    refund: {
      status: row.refund_status,
      method: row.refund_method,
      reference: row.refund_reference,
      calculated: row.refund_calculated === null || row.refund_calculated === undefined ? null : Number(row.refund_calculated),
      deduction: row.refund_deduction === null || row.refund_deduction === undefined ? null : Number(row.refund_deduction),
      deductionReason: row.refund_deduction_reason,
      amount: row.refund_amount === null || row.refund_amount === undefined ? null : Number(row.refund_amount),
      error: row.refund_error,
    },
    refundPreview,
    history: history.map((h) => ({
      from: h.from_status,
      to: h.to_status,
      note: h.note,
      actorRole: h.actor_role,
      at: h.created_iso,
    })),
    next: TRANSITIONS[row.status] || [],
  };
};

const listForAdmin = async ({ page, limit, status, search } = {}) =>
  wrapMissing(async () => {
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
    const pool = await poolPromise;

    const where = [];
    const params = [];
    if (typeof status === "string" && status) {
      if (!Object.keys(TRANSITIONS).includes(status)) throw httpError(400, "Unknown status.");
      where.push("status = ?");
      params.push(status);
    }

    // Order-number or customer search is resolved first and applied as an id list.
    const term = cleanText(search, 60);
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      const [orderMatches] = await pool.execute("SELECT id FROM orders WHERE order_number LIKE ? LIMIT 200", [like]);
      const [people] = await pool.execute("SELECT id FROM profiles WHERE email LIKE ? OR full_name LIKE ? LIMIT 200", [like, like]);
      const clauses = [];
      if (orderMatches.length) {
        clauses.push(`order_id IN (${orderMatches.map(() => "?").join(", ")})`);
        params.push(...orderMatches.map((r) => String(r.id)));
      }
      if (people.length) {
        clauses.push(`user_id IN (${people.map(() => "?").join(", ")})`);
        params.push(...people.map((r) => String(r.id)));
      }
      if (clauses.length === 0) {
        return { returns: [], pagination: { page: pageNumber, limit: pageSize, total: 0, totalPages: 1 } };
      }
      where.push(`(${clauses.join(" OR ")})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [[countRow], [rows]] = await Promise.all([
      pool.execute(`SELECT COUNT(*) AS total FROM return_requests ${whereSql}`, params),
      pool.execute(
        `SELECT ${RETURN_SELECT} FROM return_requests ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ${pageSize} OFFSET ${(pageNumber - 1) * pageSize}`,
        params
      ),
    ]);

    const history = await loadHistory(pool, rows.map((r) => r.id));
    const out = [];
    for (const row of rows) {
      const order = await loadOrder(pool, row.order_id);
      const [people] = await pool.execute("SELECT id, full_name, email FROM profiles WHERE id = ? LIMIT 1", [row.user_id]);
      const lines = await loadLines(pool, row.order_id);
      const itemRows = await loadReturnItems(pool, row.id);
      const commitments = await calc.loadCommitments(pool, row.order_id, lines);
      out.push(shapeAdminReturn(row, order, people[0], lines, itemRows, history.get(row.id) || [], commitments));
    }

    const total = Number(countRow[0]?.total || 0);
    return {
      returns: out,
      pagination: { page: pageNumber, limit: pageSize, total, totalPages: Math.max(Math.ceil(total / pageSize), 1) },
      inspectionResults: reasons.INSPECTION_RESULTS,
      manualRefundMethods: reasons.MANUAL_REFUND_METHODS,
    };
  });

const getForAdmin = async (id) =>
  wrapMissing(async () => {
    const pool = await poolPromise;
    const [rows] = await pool.execute(`SELECT ${RETURN_SELECT} FROM return_requests WHERE id = ? LIMIT 1`, [id]);
    if (!rows[0]) throw httpError(404, "Return request not found.");
    const row = rows[0];
    const order = await loadOrder(pool, row.order_id);
    const [people] = await pool.execute("SELECT id, full_name, email FROM profiles WHERE id = ? LIMIT 1", [row.user_id]);
    const lines = await loadLines(pool, row.order_id);
    const commitments = await calc.loadCommitments(pool, row.order_id, lines);
    const history = await loadHistory(pool, [row.id]);
    return shapeAdminReturn(row, order, people[0], lines, await loadReturnItems(pool, row.id), history.get(row.id) || [], commitments);
  });

// ---- admin: lifecycle ---------------------------------------------------------------------------

const requireText = (value, label, min = 5, max = 500) => {
  const text = cleanText(value, max);
  if (text.length < min) throw httpError(400, `Please give a ${label} of at least ${min} characters.`);
  return text;
};

const customerData = async (executor, request) => {
  const order = await loadOrder(executor, request.order_id);
  const lines = await loadLines(executor, request.order_id);
  const items = await loadReturnItems(executor, request.id);
  const byLine = new Map(lines.map((l) => [String(l.id), l]));
  return {
    order,
    summary: items.map((i) => `${i.quantity} × ${byLine.get(String(i.order_item_id))?.product_name || "item"}`).join(", "),
  };
};

const decide = async ({ id, decision, reason, actor }) => {
  if (decision !== "approve" && decision !== "reject") throw httpError(400, "Decision must be approve or reject.");
  const note = requireText(reason, "reason");
  const next = decision === "approve" ? "Approved" : "Rejected";

  const request = await wrapMissing(() =>
    withConnection(async (connection) => {
      const row = await lockReturn(connection, id);
      await moveStatus(connection, row, next, actor, note, "decision_reason = ?, decided_by = ?, decided_at = UTC_TIMESTAMP(6)", [note, actor.id]);
      return row;
    })
  );

  await audit.record({
    actor,
    action: decision === "approve" ? "return.approve" : "return.reject",
    resourceType: "return",
    resourceId: id,
    reason: note,
    before: { status: "Requested" },
    after: { status: next, orderId: request.order_id },
    dedupeKey: `return.decision:${id}:${next}`,
  });

  const pool = await poolPromise;
  const data = await customerData(pool, request);
  await notifications.notifyUser({
    userId: request.user_id,
    dedupeKey: `return-${decision === "approve" ? "approved" : "rejected"}:${id}`,
    template: decision === "approve" ? "return_approved" : "return_rejected",
    data: { orderNumber: data.order?.order_number, items: data.summary, reason: note },
  });

  return { id, status: next };
};

// Customer (own request) or admin: "the items are on their way back".
const markShipped = async ({ id, trackingReference, actor, ownerUserId = null }) => {
  const tracking = cleanText(trackingReference, TRACKING_MAX);

  const request = await wrapMissing(() =>
    withConnection(async (connection) => {
      const row = await lockReturn(connection, id);
      if (ownerUserId && row.user_id !== ownerUserId) throw httpError(404, "Return request not found.");
      await moveStatus(
        connection,
        row,
        "Shipped",
        actor,
        tracking ? `Tracking: ${tracking}` : "Marked as sent",
        "tracking_reference = ?, shipped_at = UTC_TIMESTAMP(6)",
        [tracking || null]
      );
      return row;
    })
  );

  await audit.record({
    actor,
    action: "return.shipped",
    resourceType: "return",
    resourceId: id,
    before: { status: "Approved" },
    after: { status: "Shipped", trackingReference: tracking || null },
    dedupeKey: `return.shipped:${id}`,
  });
  return { id, status: "Shipped", trackingReference: tracking || null, orderId: request.order_id };
};

// Goods have arrived. Nothing is restocked or refunded here: that follows the inspection.
const markReceived = async ({ id, note, actor }) => {
  const text = cleanText(note, 500);

  const request = await wrapMissing(() =>
    withConnection(async (connection) => {
      const row = await lockReturn(connection, id);
      await moveStatus(connection, row, "Received", actor, text || "Goods received", "received_by = ?, received_at = UTC_TIMESTAMP(6)", [actor.id]);
      return row;
    })
  );

  await audit.record({
    actor,
    action: "return.received",
    resourceType: "return",
    resourceId: id,
    reason: text || null,
    before: { status: request.status },
    after: { status: "Received" },
    dedupeKey: `return.received:${id}`,
  });

  const pool = await poolPromise;
  const data = await customerData(pool, request);
  await notifications.notifyUser({
    userId: request.user_id,
    dedupeKey: `return-received:${id}`,
    template: "return_received",
    data: { orderNumber: data.order?.order_number },
  });
  return { id, status: "Received" };
};

const INSPECTION_CODES = reasons.codes(reasons.INSPECTION_RESULTS);

// inspections: [{ orderItemId, result, note, refundable, restock?, authorizeRestock? }] for EVERY item.
const inspect = async ({ id, inspections, actor }) => {
  if (!Array.isArray(inspections) || inspections.length === 0) {
    throw httpError(400, "Inspect every returned item.", "NO_INSPECTIONS");
  }

  const outcome = await wrapMissing(() =>
    withConnection(async (connection) => {
      const row = await lockReturn(connection, id);
      assertTransition(row.status, "Inspected");

      const items = await loadReturnItems(connection, id);
      const lines = await loadLines(connection, row.order_id);
      const byLine = new Map(lines.map((l) => [String(l.id), l]));
      const given = new Map();
      for (const entry of inspections) {
        const key = typeof entry?.orderItemId === "string" ? entry.orderItemId : "";
        if (given.has(key)) throw httpError(400, "The same item was inspected twice.");
        given.set(key, entry);
      }
      if (given.size !== items.length || items.some((i) => !given.has(String(i.order_item_id)))) {
        throw httpError(400, "Every returned item must be inspected, once.", "INCOMPLETE_INSPECTION");
      }

      const decided = [];
      for (const item of items) {
        const entry = given.get(String(item.order_item_id));
        const name = byLine.get(String(item.order_item_id))?.product_name || "item";
        if (!INSPECTION_CODES.includes(entry.result)) throw httpError(400, `Choose an inspection result for ${name}.`);
        if (typeof entry.refundable !== "boolean") throw httpError(400, `Say whether ${name} is refundable.`);

        const note = cleanText(entry.note, 500);
        if (entry.result !== "unused_original" && note.length < 5) {
          throw httpError(400, `Add an inspection note for ${name}.`);
        }

        // Resalable only if unused. Anything else needs an explicit authorisation and a note.
        let restock = entry.result === "unused_original";
        const wantsOverride = entry.restock === true && entry.result !== "unused_original";
        if (wantsOverride) {
          if (entry.result === "incorrect_item") {
            throw httpError(400, `${name} is not our product, so it cannot be put back in stock.`);
          }
          if (entry.authorizeRestock !== true) {
            throw httpError(400, `Restocking ${name} (${entry.result.replace("_", " ")}) needs explicit authorisation.`, "RESTOCK_NOT_AUTHORIZED");
          }
          restock = true;
        }
        if (entry.restock === false) restock = false;

        decided.push({ item, name, result: entry.result, note, refundable: entry.refundable, restock, authorized: wantsOverride });
      }

      for (const d of decided) {
        await connection.execute(
          `UPDATE return_request_items
           SET inspection_result = ?, inspection_note = ?, refundable = ?, restock = ?, restock_authorized = ?
           WHERE id = ?`,
          [d.result, d.note || null, d.refundable ? 1 : 0, d.restock ? 1 : 0, d.authorized ? 1 : 0, d.item.id]
        );

        // Stock: once, only now (after goods arrived AND were judged resalable).
        if (d.restock && !d.item.restocked_at && d.item.variant_id) {
          const [marked] = await connection.execute(
            "UPDATE return_request_items SET restocked_at = UTC_TIMESTAMP(6) WHERE id = ? AND restocked_at IS NULL",
            [d.item.id]
          );
          if (marked.affectedRows === 1) {
            await connection.execute(
              "UPDATE product_variants SET inventory = inventory + ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
              [d.item.quantity, d.item.variant_id]
            );
            await inventoryHistory.recordVariantDelta(connection, {
              variantId: d.item.variant_id,
              delta: Number(d.item.quantity),
              reason: `Return inspected - back in stock (${d.name})`,
              source: "return_received",
              referenceType: "return",
              referenceId: id,
              actorId: actor.id,
              dedupeKey: `return_restock:${id}:${d.item.order_item_id}`,
            });
          }
        }
      }

      const anyRefundable = decided.some((d) => d.refundable);
      await moveStatus(connection, row, "Inspected", actor, anyRefundable ? "Inspection complete" : "Inspection complete - nothing refundable", "inspected_by = ?, inspected_at = UTC_TIMESTAMP(6)", [actor.id]);

      // Nothing to refund: the return is finished.
      if (!anyRefundable) {
        await connection.execute(
          "UPDATE return_requests SET refund_status = 'not_applicable', updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
          [id]
        );
        await finishReturn(connection, { ...row, status: "Inspected" }, actor, "No refundable items");
      }

      return { row, decided, anyRefundable };
    })
  );

  await audit.record({
    actor,
    action: "return.inspect",
    resourceType: "return",
    resourceId: id,
    before: { status: "Received" },
    after: {
      status: outcome.anyRefundable ? "Inspected" : "Completed",
      items: outcome.decided.map((d) => ({
        orderItemId: d.item.order_item_id,
        result: d.result,
        refundable: d.refundable,
        restocked: d.restock,
        restockAuthorized: d.authorized,
      })),
    },
    dedupeKey: `return.inspect:${id}`,
  });

  const pool = await poolPromise;
  const data = await customerData(pool, outcome.row);
  await notifications.notifyUser({
    userId: outcome.row.user_id,
    dedupeKey: `return-inspected:${id}`,
    template: "return_inspected",
    data: { orderNumber: data.order?.order_number, refundable: outcome.anyRefundable },
  });

  return { id, status: outcome.anyRefundable ? "Inspected" : "Completed", refundable: outcome.anyRefundable };
};

// Marks Inspected -> Completed and, when every unit of the order is back, the order Returned.
const finishReturn = async (connection, request, actor, note) => {
  const [moved] = await connection.execute(
    `UPDATE return_requests SET status = 'Completed', completed_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
     WHERE id = ? AND status = 'Inspected'`,
    [request.id]
  );
  if (moved.affectedRows !== 1) return false;
  await recordHistory(connection, request.id, "Inspected", "Completed", actor, note);

  // The order becomes Returned only when every unit has come back and been finished.
  const lines = await loadLines(connection, request.order_id);
  const [done] = await connection.execute(
    `SELECT i.order_item_id, SUM(i.quantity) AS quantity
     FROM return_request_items i INNER JOIN return_requests r ON r.id = i.return_id
     WHERE r.order_id = ? AND r.status = 'Completed' GROUP BY i.order_item_id`,
    [request.order_id]
  );
  const back = new Map(done.map((d) => [String(d.order_item_id), Number(d.quantity)]));
  // Units cancelled before dispatch never came back, but they are not outstanding either.
  const commitments = await calc.loadCommitments(connection, request.order_id, lines);
  const all =
    lines.length > 0 &&
    lines.every(
      (line) =>
        (back.get(String(line.id)) || 0) + (commitments.cancelledByLine.get(String(line.id)) || 0) >= Number(line.quantity)
    );
  if (all) {
    await connection.execute(
      "UPDATE orders SET status = 'Returned', updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND status = 'Delivered'",
      [request.order_id]
    );
  }
  return true;
};

// Decides the refund from the inspection, then pays it (Razorpay) or records the
// manual payout (cash on delivery).
const processRefund = async ({ id, deduction, deductionReason, method, reference, actor }) => {
  const prepared = await wrapMissing(() =>
    withConnection(async (connection) => {
      const row = await lockReturn(connection, id);
      if (row.status !== "Inspected") {
        throw httpError(409, "A refund can only be processed after the items are inspected.", "INVALID_TRANSITION");
      }
      if (row.refund_status) {
        throw httpError(409, "A refund was already processed for this return.", "REFUND_ALREADY_PROCESSED");
      }

      const order = await loadOrder(connection, row.order_id, true);
      const lines = await loadLines(connection, row.order_id);
      const items = await loadReturnItems(connection, id);
      const refundable = items.filter((i) => i.refundable);
      const commitments = await calc.loadCommitments(connection, row.order_id, lines);

      const deductionPaise = Math.round(Number(deduction || 0) * 100);
      if (!Number.isFinite(deductionPaise) || deductionPaise < 0) throw httpError(400, "The deduction must be zero or more.");
      const note = deductionPaise > 0 ? requireText(deductionReason, "reason for the deduction") : "";

      const breakdown = calc.computeRefund({
        order,
        lines,
        picks: refundable.map((i) => ({
          orderItemId: String(i.order_item_id),
          quantity: Number(i.quantity),
          offset: calc.committedUnits(commitments, i.order_item_id, { beforeReturnId: id }),
        })),
        includeShipping: false,
        deductionPaise,
        alreadyRefundedPaise: commitments.refundedPaise,
      });

      const online = same(order.payment_method, "online") && paymentStatus.isHeld(order.payment_status) && Boolean(order.payment_id);
      const cod = same(order.payment_method, "cod") && paymentStatus.isHeld(order.payment_status);

      let refundMethod = null;
      let refundReference = null;
      let status;
      if (breakdown.finalPaise <= 0) {
        status = "not_applicable";
      } else if (online) {
        refundMethod = "razorpay";
        status = "pending";
      } else if (cod) {
        // Money was handed over in cash: a person pays it back and confirms how.
        if (!reasons.codes(reasons.MANUAL_REFUND_METHODS).includes(method)) {
          throw httpError(400, "Choose how the customer was refunded.", "METHOD_REQUIRED");
        }
        refundReference = requireText(reference, "payment reference", 3, 100);
        refundMethod = method;
        status = "completed";
      } else {
        status = "not_applicable"; // nothing was ever collected
      }

      for (const line of breakdown.lines) {
        await connection.execute(
          "UPDATE return_request_items SET line_refund = ? WHERE return_id = ? AND order_item_id = ?",
          [line.refund, id, line.orderItemId]
        );
      }
      await connection.execute(
        `UPDATE return_requests
         SET refund_status = ?, refund_calculated = ?, refund_deduction = ?, refund_deduction_reason = ?,
             refund_amount = ?, refund_method = ?, refund_reference = ?, refund_processed_by = ?,
             refund_completed_at = ${status === "completed" ? "UTC_TIMESTAMP(6)" : "NULL"},
             updated_at = UTC_TIMESTAMP(6)
         WHERE id = ? AND refund_status IS NULL`,
        [status, breakdown.calculated, breakdown.deduction, note || null, breakdown.final, refundMethod, refundReference, actor.id, id]
      );
      await recordHistory(
        connection,
        id,
        "Inspected",
        "Inspected",
        actor,
        `Refund ${status === "pending" ? "sent for processing" : status.replace("_", " ")}: ₹${breakdown.final.toFixed(2)}`
      );

      return { row, order, breakdown, status, refundMethod };
    })
  );

  await audit.record({
    actor,
    action: "return.refund",
    resourceType: "return",
    resourceId: id,
    reason: deductionReason ? cleanText(deductionReason, 500) : null,
    after: {
      method: prepared.refundMethod,
      calculated: prepared.breakdown.calculated,
      deduction: prepared.breakdown.deduction,
      amount: prepared.breakdown.final,
      status: prepared.status,
      reference: prepared.status === "completed" ? cleanText(reference, 100) : undefined,
    },
    dedupeKey: `return.refund:${id}`,
  });

  if (prepared.status === "pending") {
    await refundRunner.runRefund({ table: "return_requests", id, order: prepared.order, amount: prepared.breakdown.final });
  }
  await afterRefundChange(id, actor);

  const pool = await poolPromise;
  const [rows] = await pool.execute("SELECT status, refund_status, refund_amount FROM return_requests WHERE id = ? LIMIT 1", [id]);
  return { id, status: rows[0].status, refundStatus: rows[0].refund_status, amount: money(rows[0].refund_amount), breakdown: prepared.breakdown };
};

// Follow-ups once a refund changes state: finish the return, e-mail the customer.
const afterRefundChange = async (returnId, actor = null) => {
  try {
    const pool = await poolPromise;
    const [rows] = await pool.execute("SELECT * FROM return_requests WHERE id = ? LIMIT 1", [returnId]);
    const row = rows[0];
    if (!row) return null;

    let status = row.status;
    if (row.refund_status === "completed" && row.status === "Inspected") {
      const finished = await withConnection((connection) =>
        finishReturn(connection, row, actor || { id: null, role: "system" }, "Refund completed")
      );
      if (finished) status = "Completed";
    }

    // The order's payment status follows its refunds (Partially Refunded / Refunded).
    await paymentState.syncOrderPayment(pool, row.order_id);

    const order = await loadOrder(pool, row.order_id);
    const data = {
      orderNumber: order?.order_number,
      amount: money(row.refund_amount),
      method: row.refund_method === "razorpay" ? "to your original payment method" : row.refund_method ? row.refund_method.replace("_", " ") : "",
      reference: row.refund_method === "razorpay" ? "" : row.refund_reference,
    };
    const template = { processing: "return_refund_processing", completed: "return_refund_completed", failed: "return_refund_failed" }[row.refund_status];
    if (template && Number(row.refund_amount) > 0) {
      await notifications.notifyUser({ userId: row.user_id, dedupeKey: `${template}:${returnId}`, template, data });
    }
    return status;
  } catch (error) {
    console.error("afterRefundChange (return) failed:", error.code || error.message);
    return null;
  }
};

const retryRefund = async ({ id, actor }) =>
  wrapMissing(async () => {
    const pool = await poolPromise;
    const [rows] = await pool.execute("SELECT * FROM return_requests WHERE id = ? LIMIT 1", [id]);
    const row = rows[0];
    if (!row) throw httpError(404, "Return request not found.");
    if (row.status !== "Inspected" || !["pending", "processing", "failed"].includes(row.refund_status) || row.refund_method !== "razorpay") {
      throw httpError(409, "This refund does not need a retry.", "INVALID_TRANSITION");
    }

    const order = await loadOrder(pool, row.order_id);
    const outcome = await refundRunner.runRefund({ table: "return_requests", id, order, amount: Number(row.refund_amount) });
    await afterRefundChange(id, actor);

    await audit.record({
      actor,
      action: "return.refund_retry",
      resourceType: "return",
      resourceId: id,
      outcome: outcome.status === "failed" ? "failure" : "success",
      before: { refund: row.refund_status },
      after: { refund: outcome.status, amount: Number(row.refund_amount), reason: outcome.reason || outcome.error || null },
    });

    if (outcome.reason === "in_flight") {
      throw httpError(409, "A refund attempt is already in progress. Wait a minute, then check again.", "IN_FLIGHT");
    }
    return { id, refundStatus: outcome.status };
  });

const options = () => ({
  reasons: reasons.RETURN_REASONS,
  inspectionResults: reasons.INSPECTION_RESULTS,
  manualRefundMethods: reasons.MANUAL_REFUND_METHODS,
});

module.exports = {
  getPolicy,
  options,
  createRequest,
  preview,
  getForCustomer,
  listForAdmin,
  getForAdmin,
  decide,
  markShipped,
  markReceived,
  inspect,
  processRefund,
  retryRefund,
  afterRefundChange,
  TRANSITIONS,
};
