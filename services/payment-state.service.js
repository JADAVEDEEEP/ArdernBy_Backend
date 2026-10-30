const calc = require("./refund-calc.service");
const status = require("../utils/payment-status");

// ==========================================
// ORDER PAYMENT STATUS FOLLOWS ITS REFUNDS
//
// An order's payment status is worked out from the refund records of the new
// cancellation / return flow (never from a single flag), in paise:
//
//   everything collected is confirmed paid back          -> Refunded
//   the order is cancelled and a refund is unfinished    -> Refund Pending
//   some money confirmed paid back, some still with us   -> Partially Refunded
//   nothing confirmed yet                                -> unchanged
//
// Orders that have no records in the new tables (the original whole-order
// cancel) are never touched here: their Refund Pending / Refunded handling is
// unchanged. Only "completed" refunds count as paid back; a refund Razorpay has
// accepted but not processed does not.
// ==========================================

const lc = (value) => String(value || "").trim().toLowerCase();
const isMissingTable = (error) => Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);

const OPEN = ["pending", "processing", "failed"];

// Pure: the status an order should have. `null` means "leave it as it is".
const nextPaymentStatus = ({ orderStatus, paymentStatus, totalPaise, completedPaise, openPaise, hasRecords }) => {
  if (!hasRecords) return null;
  if (!status.isCollected(paymentStatus)) return null;

  if (completedPaise >= totalPaise && totalPaise > 0) return status.REFUNDED;
  if (lc(orderStatus) === "cancelled" && openPaise > 0) return status.REFUND_PENDING;
  if (completedPaise > 0) return status.PARTIALLY_REFUNDED;
  // Nothing paid back yet: a cancelled order's money is on its way, anything else is still simply Paid.
  if (lc(orderStatus) === "cancelled" && openPaise === 0) return null;
  return lc(paymentStatus) === lc(status.PARTIALLY_REFUNDED) ? status.PAID : null;
};

const refundTotals = async (executor, orderId) => {
  let completedPaise = 0;
  let openPaise = 0;
  let hasRecords = false;

  for (const table of ["order_cancellations", "return_requests"]) {
    try {
      const [rows] = await executor.execute(
        `SELECT refund_status, refund_amount FROM ${table} WHERE order_id = ? AND refund_status IS NOT NULL AND refund_status <> 'not_applicable'`,
        [orderId]
      );
      for (const row of rows) {
        const paise = calc.toPaise(row.refund_amount || 0);
        if (paise <= 0) continue;
        hasRecords = true;
        if (row.refund_status === "completed") completedPaise += paise;
        else if (OPEN.includes(row.refund_status)) openPaise += paise;
      }
    } catch (error) {
      if (!isMissingTable(error)) throw error;
    }
  }
  return { completedPaise, openPaise, hasRecords };
};

const syncOrderPayment = async (executor, orderId) => {
  const [orders] = await executor.execute(
    "SELECT status, payment_status, total_amount FROM orders WHERE id = ? LIMIT 1",
    [orderId]
  );
  const order = orders[0];
  if (!order) return null;

  const totals = await refundTotals(executor, orderId);
  const next = nextPaymentStatus({
    orderStatus: order.status,
    paymentStatus: order.payment_status,
    totalPaise: calc.toPaise(order.total_amount),
    ...totals,
  });

  if (next && next !== order.payment_status) {
    // Conditional on the value we read, so a concurrent change is never overwritten.
    await executor.execute(
      "UPDATE orders SET payment_status = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND payment_status = ?",
      [next, orderId, order.payment_status]
    );
    return next;
  }
  return order.payment_status;
};

module.exports = { syncOrderPayment, nextPaymentStatus, refundTotals };
