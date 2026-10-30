const { poolPromise } = require("../config/sql");
const { resolveRange } = require("./analytics.service");
const refundSql = require("./refund-sql.service");

// ==========================================
// FINANCIAL REPORT (Super Admin)
//
// Built only from the `orders` table and the status words the project already
// uses. Every order falls into exactly ONE group below (a single CASE per
// metric over one pass of the table, no joins), so nothing is counted twice.
//
//   Gross order value   all orders placed in the range (what customers ordered)
//   Collected           payment_status Paid, Partially Refunded, Refund Pending or
//                       Refunded: money that actually arrived at some point (online
//                       captured, or COD cash recorded on delivery)
//   Refunded            refunds confirmed paid back. Partial cancellations and
//                       returns count only the amount refunded (see refund-sql);
//                       the original whole-order cancel counts the whole total
//   Refund pending      refunds promised but NOT yet confirmed
//   Net received        Collected - Refunded            (confirmed figures only)
//   Net after pending   Net received - Refund pending   (if every pending
//                       refund completes)
//   Failed payments     payment_status Failed (never collected)
//
// Limits stated in the response (`notes`): there is no single refund date, so
// refunds appear in the period the ORDER was placed; COD returns need a manual
// cash refund and are shown separately.
// ==========================================

const COLLECTED = "LOWER(o.payment_status) IN ('paid', 'partially refunded', 'refund pending', 'refunded')";
const IST_DAY = "DATE_FORMAT(DATE_ADD(o.created_at, INTERVAL 330 MINUTE), '%Y-%m-%d')";

const num = (value) => Number(value || 0);
const money = (value) => Math.round(num(value) * 100) / 100;

const sum = (cond) => `COALESCE(SUM(CASE WHEN ${cond} THEN o.total_amount ELSE 0 END), 0)`;
const cnt = (cond) => `COALESCE(SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END), 0)`;

// Built per report: the refund expressions depend on whether the item-level tables exist.
const buildMetrics = () => ({
  orders: cnt("1 = 1"),
  gross_value: sum("1 = 1"),
  subtotal: "COALESCE(SUM(o.subtotal), 0)",
  discounts: "COALESCE(SUM(o.discount_amount), 0)",
  shipping: "COALESCE(SUM(o.shipping_amount), 0)",
  tax: "COALESCE(SUM(o.tax_amount), 0)",
  collected: sum(COLLECTED),
  collected_orders: cnt(COLLECTED),
  refunded: `COALESCE(SUM(${refundSql.refunded()}), 0)`,
  refunded_orders: cnt(`${refundSql.refunded()} > 0`),
  partially_refunded_orders: cnt("LOWER(o.payment_status) = 'partially refunded'"),
  refund_pending: `COALESCE(SUM(${refundSql.openRefund()}), 0)`,
  refund_pending_orders: cnt(`${refundSql.openRefund()} > 0`),
  failed: sum("LOWER(o.payment_status) = 'failed'"),
  failed_orders: cnt("LOWER(o.payment_status) = 'failed'"),
  awaiting_payment: sum("LOWER(o.payment_status) = 'pending' AND LOWER(o.status) NOT IN ('cancelled')"),
  awaiting_payment_orders: cnt("LOWER(o.payment_status) = 'pending' AND LOWER(o.status) NOT IN ('cancelled')"),
  cancelled: sum("LOWER(o.status) = 'cancelled'"),
  cancelled_orders: cnt("LOWER(o.status) = 'cancelled'"),
  cancelled_after_payment: sum(`LOWER(o.status) = 'cancelled' AND ${COLLECTED}`),
  returned: sum("LOWER(o.status) = 'returned'"),
  returned_orders: cnt("LOWER(o.status) = 'returned'"),
  cod_return_unrefunded: sum(
    "LOWER(o.status) = 'returned' AND LOWER(o.payment_method) = 'cod' AND LOWER(o.payment_status) = 'paid'"
  ),
  online_collected: sum(`LOWER(o.payment_method) = 'online' AND ${COLLECTED}`),
  cod_collected: sum(`LOWER(o.payment_method) = 'cod' AND ${COLLECTED}`),
});

const selectMetrics = () =>
  Object.entries(buildMetrics())
    .map(([name, expr]) => `${expr} AS ${name}`)
    .join(", ");

const shape = (row = {}) => {
  const collected = money(row.collected);
  const refunded = money(row.refunded);
  const refundPending = money(row.refund_pending);
  const codReturnUnrefunded = money(row.cod_return_unrefunded);

  return {
    orders: num(row.orders),
    grossOrderValue: money(row.gross_value),
    composition: {
      subtotal: money(row.subtotal),
      discounts: money(row.discounts),
      shipping: money(row.shipping),
      tax: money(row.tax),
    },
    payments: {
      collected,
      collectedOrders: num(row.collected_orders),
      byMethod: { online: money(row.online_collected), cod: money(row.cod_collected) },
      failed: money(row.failed),
      failedOrders: num(row.failed_orders),
      awaitingPayment: money(row.awaiting_payment),
      awaitingPaymentOrders: num(row.awaiting_payment_orders),
    },
    refunds: {
      refunded,
      refundedOrders: num(row.refunded_orders),
      partiallyRefundedOrders: num(row.partially_refunded_orders),
      refundPending,
      refundPendingOrders: num(row.refund_pending_orders),
      codReturnsAwaitingManualRefund: codReturnUnrefunded,
    },
    cancellations: {
      cancelledOrders: num(row.cancelled_orders),
      cancelledValue: money(row.cancelled),
      cancelledAfterPaymentValue: money(row.cancelled_after_payment),
    },
    returns: { returnedOrders: num(row.returned_orders), returnedValue: money(row.returned) },
    net: {
      received: money(collected - refunded),
      afterPendingRefunds: money(collected - refunded - refundPending - codReturnUnrefunded),
    },
  };
};

const NOTES = [
  "Refunded counts only money confirmed paid back: a partial cancellation or return adds just its own amount, and a refund Razorpay has accepted but not processed stays under 'refund pending'.",
  "There is no single refund date, so refunds are shown in the period the order was placed.",
  "Cash-on-delivery returns are refunded outside the system; they show as 'awaiting manual refund' until an admin records the payout.",
  "Tax is shown as stored on each order; no separate tax filing report is produced.",
];

const getFinancialReport = async ({ from, to } = {}) => {
  const range = resolveRange({ from, to });
  const pool = await poolPromise;
  await refundSql.refresh(pool);
  const SELECT_METRICS = selectMetrics();
  const params = [range.current.start, range.current.end];

  const [[totalRows], [dayRows]] = await Promise.all([
    pool.execute(
      `SELECT ${SELECT_METRICS} FROM orders o WHERE o.created_at >= ? AND o.created_at < ?`,
      params
    ),
    pool.execute(
      `
        SELECT ${IST_DAY} AS day, ${SELECT_METRICS}
        FROM orders o
        WHERE o.created_at >= ? AND o.created_at < ?
        GROUP BY day
        ORDER BY day
      `,
      params
    ),
  ]);

  return {
    range: { from: range.current.from, to: range.current.to, days: range.current.days },
    generatedAt: new Date().toISOString(),
    currency: "INR",
    totals: shape(totalRows[0]),
    daily: dayRows.map((row) => ({
      date: row.day,
      orders: num(row.orders),
      grossOrderValue: money(row.gross_value),
      collected: money(row.collected),
      refunded: money(row.refunded),
      refundPending: money(row.refund_pending),
      failed: money(row.failed),
      cancelled: money(row.cancelled),
    })),
    notes: NOTES,
  };
};

module.exports = { getFinancialReport, NOTES };
