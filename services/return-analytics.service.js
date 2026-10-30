const { poolPromise } = require("../config/sql");
const { resolveRange } = require("./analytics.service");
const reasons = require("../utils/reasons");

// ==========================================
// CANCELLATION & RETURN ANALYTICS
//
// Built from the real records:
//   order_cancellations / order_cancellation_items   what was cancelled
//   return_requests / return_request_items           what came back
//   orders / order_items                             what was sold
//
// Counting rules (so partial returns are never double counted):
//   * a "return request" is one row in return_requests; its items are never
//     added again as requests;
//   * "units returned" are summed from return_request_items, and requests that
//     were Rejected are excluded from units and rates;
//   * money comes from the refund columns, by the day the refund COMPLETED, and
//     pending / failed refunds are reported on their own;
//   * rates divide by units SOLD in the same date range (delivered or later).
// ==========================================

const num = (value) => Number(value || 0);
const money = (value) => Math.round(num(value) * 100) / 100;
const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

const isMissingTable = (error) =>
  Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);

const safe = async (work, fallback) => {
  try {
    return await work();
  } catch (error) {
    if (isMissingTable(error)) return fallback;
    throw error;
  }
};

const getReturnAnalytics = async ({ from, to, productId } = {}) => {
  const range = resolveRange({ from, to }).current;
  const pool = await poolPromise;
  const window = [range.start, range.end];

  const available = await safe(async () => {
    await pool.execute("SELECT 1 FROM order_cancellations LIMIT 1");
    await pool.execute("SELECT 1 FROM return_requests LIMIT 1");
    return true;
  }, false);

  const [[orderRow]] = await pool.execute(
    `
      SELECT
        COUNT(*) AS placed,
        COALESCE(SUM(CASE WHEN LOWER(status) = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
      FROM orders WHERE created_at >= ? AND created_at < ?
    `,
    window
  );

  const empty = {
    available: false,
    range: { from: range.from, to: range.to, days: range.days },
    cancellations: { requests: 0, wholeOrders: 0, partial: 0, ordersCancelled: num(orderRow?.cancelled), ordersPlaced: num(orderRow?.placed), cancellationRatePercent: rate(num(orderRow?.cancelled), num(orderRow?.placed)) },
    returns: { requests: 0, pending: 0, approved: 0, rejected: 0, inProgress: 0, completed: 0, unitsReturned: 0, unitsSold: 0, returnRatePercent: null },
    refunds: { refundedAmount: 0, pendingAmount: 0, failedCount: 0, pendingCount: 0 },
    reasons: { cancellation: [], returns: [] },
    products: [],
  };
  if (!available) return empty;

  // ---- cancellations
  const [[cancel]] = await pool.execute(
    `
      SELECT COUNT(*) AS requests,
             COALESCE(SUM(whole_order), 0) AS whole
      FROM order_cancellations WHERE created_at >= ? AND created_at < ?
    `,
    window
  );

  // ---- returns by status (one row per request, created in the range)
  const [statusRows] = await pool.execute(
    "SELECT status, COUNT(*) AS n FROM return_requests WHERE created_at >= ? AND created_at < ? GROUP BY status",
    window
  );
  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, num(r.n)]));
  const returnRequests = Object.values(byStatus).reduce((a, b) => a + b, 0);

  // ---- units
  const [[units]] = await pool.execute(
    `
      SELECT COALESCE(SUM(i.quantity), 0) AS returned
      FROM return_request_items i
      INNER JOIN return_requests r ON r.id = i.return_id
      WHERE r.created_at >= ? AND r.created_at < ? AND r.status <> 'Rejected'
    `,
    window
  );
  const [[sold]] = await pool.execute(
    `
      SELECT COALESCE(SUM(oi.quantity), 0) AS sold
      FROM order_items oi
      INNER JOIN orders o ON o.id = oi.order_id
      WHERE o.created_at >= ? AND o.created_at < ? AND LOWER(o.status) IN ('delivered', 'returned')
    `,
    window
  );

  // ---- refunds (money by the day the refund completed; pending/failed separately)
  const [[doneC]] = await pool.execute(
    "SELECT COALESCE(SUM(refund_amount), 0) AS amount FROM order_cancellations WHERE refund_status = 'completed' AND COALESCE(refund_completed_at, updated_at) >= ? AND COALESCE(refund_completed_at, updated_at) < ?",
    window
  );
  const [[doneR]] = await pool.execute(
    "SELECT COALESCE(SUM(refund_amount), 0) AS amount FROM return_requests WHERE refund_status = 'completed' AND COALESCE(refund_completed_at, updated_at) >= ? AND COALESCE(refund_completed_at, updated_at) < ?",
    window
  );
  const [[openC]] = await pool.execute(
    `SELECT COALESCE(SUM(CASE WHEN refund_status IN ('pending', 'processing', 'failed') THEN refund_amount END), 0) AS amount,
            COALESCE(SUM(CASE WHEN refund_status IN ('pending', 'processing', 'failed') THEN 1 ELSE 0 END), 0) AS n,
            COALESCE(SUM(CASE WHEN refund_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
     FROM order_cancellations`
  );
  const [[openR]] = await pool.execute(
    `SELECT COALESCE(SUM(CASE WHEN refund_status IN ('pending', 'processing', 'failed') THEN refund_amount END), 0) AS amount,
            COALESCE(SUM(CASE WHEN refund_status IN ('pending', 'processing', 'failed') THEN 1 ELSE 0 END), 0) AS n,
            COALESCE(SUM(CASE WHEN refund_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
     FROM return_requests`
  );

  // ---- reasons
  const [cancelReasons] = await pool.execute(
    "SELECT reason_code, COUNT(*) AS n FROM order_cancellations WHERE created_at >= ? AND created_at < ? GROUP BY reason_code ORDER BY n DESC LIMIT 10",
    window
  );
  const [returnReasons] = await pool.execute(
    "SELECT reason_code, COUNT(*) AS n FROM return_requests WHERE created_at >= ? AND created_at < ? AND reason_code IS NOT NULL GROUP BY reason_code ORDER BY n DESC LIMIT 10",
    window
  );

  // ---- product-wise
  const productFilter = typeof productId === "string" && productId.trim() ? productId.trim().slice(0, 64) : null;
  const [returnedByProduct] = await pool.execute(
    `
      SELECT i.product_id, SUM(i.quantity) AS units, COUNT(DISTINCT i.return_id) AS requests
      FROM return_request_items i
      INNER JOIN return_requests r ON r.id = i.return_id
      WHERE r.created_at >= ? AND r.created_at < ? AND r.status <> 'Rejected'
        AND i.product_id IS NOT NULL ${productFilter ? "AND i.product_id = ?" : ""}
      GROUP BY i.product_id ORDER BY units DESC LIMIT 25
    `,
    productFilter ? [...window, productFilter] : window
  );
  const ids = returnedByProduct.map((r) => String(r.product_id));
  const names = new Map();
  const soldByProduct = new Map();
  if (ids.length > 0) {
    const marks = ids.map(() => "?").join(", ");
    const [products] = await pool.execute(`SELECT id, name FROM products WHERE id IN (${marks})`, ids);
    for (const p of products) names.set(String(p.id), p.name);
    const [soldRows] = await pool.execute(
      `
        SELECT oi.product_id, SUM(oi.quantity) AS sold
        FROM order_items oi INNER JOIN orders o ON o.id = oi.order_id
        WHERE o.created_at >= ? AND o.created_at < ? AND LOWER(o.status) IN ('delivered', 'returned')
          AND oi.product_id IN (${marks})
        GROUP BY oi.product_id
      `,
      [...window, ...ids]
    );
    for (const s of soldRows) soldByProduct.set(String(s.product_id), num(s.sold));
  }

  const pendingCount = num(openC.n) + num(openR.n);
  return {
    available: true,
    range: { from: range.from, to: range.to, days: range.days },
    cancellations: {
      requests: num(cancel.requests),
      wholeOrders: num(cancel.whole),
      partial: num(cancel.requests) - num(cancel.whole),
      ordersCancelled: num(orderRow.cancelled),
      ordersPlaced: num(orderRow.placed),
      cancellationRatePercent: rate(num(orderRow.cancelled), num(orderRow.placed)),
    },
    returns: {
      requests: returnRequests,
      pending: num(byStatus.Requested),
      approved: num(byStatus.Approved) + num(byStatus.Shipped) + num(byStatus.Received) + num(byStatus.Inspected) + num(byStatus.Completed),
      rejected: num(byStatus.Rejected),
      inProgress: num(byStatus.Approved) + num(byStatus.Shipped) + num(byStatus.Received) + num(byStatus.Inspected),
      completed: num(byStatus.Completed),
      unitsReturned: num(units.returned),
      unitsSold: num(sold.sold),
      returnRatePercent: rate(num(units.returned), num(sold.sold)),
    },
    refunds: {
      refundedAmount: money(num(doneC.amount) + num(doneR.amount)),
      pendingAmount: money(num(openC.amount) + num(openR.amount)),
      pendingCount,
      failedCount: num(openC.failed) + num(openR.failed),
    },
    reasons: {
      cancellation: cancelReasons.map((r) => ({
        code: r.reason_code,
        label: reasons.label([...reasons.CUSTOMER_CANCEL_REASONS, ...reasons.ADMIN_CANCEL_REASONS], r.reason_code),
        count: num(r.n),
      })),
      returns: returnReasons.map((r) => ({ code: r.reason_code, label: reasons.label(reasons.RETURN_REASONS, r.reason_code), count: num(r.n) })),
    },
    products: returnedByProduct.map((r) => {
      const soldUnits = soldByProduct.get(String(r.product_id)) || 0;
      return {
        productId: r.product_id,
        name: names.get(String(r.product_id)) || "Unknown product",
        unitsReturned: num(r.units),
        requests: num(r.requests),
        unitsSold: soldUnits,
        returnRatePercent: rate(num(r.units), soldUnits),
      };
    }),
  };
};

module.exports = { getReturnAnalytics };
