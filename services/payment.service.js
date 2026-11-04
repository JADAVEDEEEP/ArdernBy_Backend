const { poolPromise } = require("../config/sql");
const razorpay = require("./razorpay.service");
const inventoryHistory = require("./inventory-history.service");
const paymentStatus = require("../utils/payment-status");
const orderEmail = require("./order-email.service");

const ORDER_FIELDS = `
  id,
  order_number,
  status,
  payment_method,
  payment_status,
  total_amount,
  payment_order_id,
  payment_id
`;

const loadOwnOrder = async (executor, userId, orderId, lock = false) => {
  const [rows] = await executor.execute(
    `
      SELECT ${ORDER_FIELDS}
      FROM orders
      WHERE id = ?
        AND user_id = ?
      LIMIT 1
      ${lock ? "FOR UPDATE" : ""}
    `,
    [orderId, userId]
  );

  if (rows.length === 0) {
    throw new Error("Order not found.");
  }

  return rows[0];
};

const isOnline = (order) =>
  String(order.payment_method).toLowerCase() === "online";

// "Paid" and "Partially Refunded" both mean the money was collected and is still held.
const isPaid = (order) => paymentStatus.isHeld(order.payment_status);

// Creates a Razorpay order for an unpaid online order. The amount always comes
// from the saved order total, never from the client.
const createPaymentOrder = async ({ userId, orderId }) => {
  const pool = await poolPromise;
  const order = await loadOwnOrder(pool, userId, orderId);

  if (!isOnline(order)) {
    throw new Error("This order is not an online payment order.");
  }
  if (isPaid(order)) {
    throw new Error("This order is already paid.");
  }
  if (order.status !== "Processing") {
    throw new Error("This order can no longer be paid.");
  }

  const rzpOrder = await razorpay.createOrder({
    amountRupees: order.total_amount,
    receipt: order.order_number,
    notes: { order_id: order.id, order_number: order.order_number },
  });

  const [result] = await pool.execute(
    `
      UPDATE orders
      SET
        payment_order_id = ?,
        payment_status = 'Pending',
        updated_at = UTC_TIMESTAMP(6)
      WHERE id = ?
        AND user_id = ?
        AND status = 'Processing'
        AND LOWER(payment_status) NOT IN ('paid', 'partially refunded')
    `,
    [rzpOrder.id, order.id, userId]
  );

  if (result.affectedRows === 0) {
    throw new Error("This order can no longer be paid.");
  }

  return {
    keyId: razorpay.getCredentials().keyId,
    razorpayOrderId: rzpOrder.id,
    amount: rzpOrder.amount,
    currency: rzpOrder.currency,
    orderId: order.id,
    orderNumber: order.order_number,
  };
};

// Confirmation e-mail once a payment is recorded. The verify, sync and webhook
// paths can all reach the same order, so this is called from each of them;
// order-email.service sends at most once per order (and only for a confirmed,
// paid order). Not awaited and never throws: e-mail must not affect payment.
const confirmByEmail = (order, outcome) => {
  if (outcome !== "paid" && outcome !== "already_paid") return;
  try {
    Promise.resolve(orderEmail.sendOrderConfirmation(order.id)).catch(() => {});
  } catch (_reason) {
    // never let an e-mail problem reach the payment flow
  }
};

// Called once a payment is verified. In ONE transaction it takes the stock,
// marks the order Paid/Confirmed and empties the customer's cart.
// Returns "paid", "already_paid" (this same payment was recorded by a concurrent
// request), "skipped" (order cancelled, or paid by a DIFFERENT payment) or
// "out_of_stock".
const finalizePaidOrder = async (order, paymentId) => {
  const pool = await poolPromise;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `
        SELECT id, user_id, status, payment_status, payment_id
        FROM orders
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [order.id]
    );

    const current = rows[0];

    // A parallel verify / sync (double submit, second tab) already recorded this
    // very payment: that is success, not a reason to refund it.
    if (
      current &&
      paymentStatus.isHeld(current.payment_status) &&
      current.payment_id === paymentId
    ) {
      await connection.rollback();
      return "already_paid";
    }

    if (
      !current ||
      current.status !== "Processing" ||
      paymentStatus.isHeld(current.payment_status)
    ) {
      await connection.rollback();
      return "skipped";
    }

    const [items] = await connection.execute(
      `
        SELECT variant_id, quantity
        FROM order_items
        WHERE order_id = ?
      `,
      [order.id]
    );

    for (const item of items) {
      if (!item.variant_id) continue;

      const [stock] = await connection.execute(
        `
          UPDATE product_variants
          SET
            inventory = inventory - ?,
            updated_at = UTC_TIMESTAMP(6)
          WHERE id = ?
            AND inventory >= ?
        `,
        [item.quantity, item.variant_id, item.quantity]
      );

      if (stock.affectedRows === 0) {
        await connection.rollback();
        return "out_of_stock";
      }

      await inventoryHistory.recordVariantDelta(connection, {
        variantId: item.variant_id,
        delta: -Number(item.quantity),
        reason: "Online payment confirmed",
        source: "order_paid",
        referenceType: "order",
        referenceId: order.id,
        actorId: current.user_id,
        dedupeKey: `order_paid:${order.id}:${item.variant_id}`,
      });
    }

    await connection.execute(
      `
        UPDATE orders
        SET
          payment_status = 'Paid',
          payment_id = ?,
          status = 'Confirmed',
          updated_at = UTC_TIMESTAMP(6)
        WHERE id = ?
      `,
      [paymentId, order.id]
    );

    await connection.execute(
      `
        DELETE FROM cart_items
        WHERE cart_id IN (SELECT id FROM carts WHERE user_id = ?)
      `,
      [current.user_id]
    );

    await connection.execute(
      `
        UPDATE carts
        SET
          coupon_code = NULL,
          updated_at = UTC_TIMESTAMP(6)
        WHERE user_id = ?
      `,
      [current.user_id]
    );

    await connection.commit();
    return "paid";
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    throw error;
  } finally {
    connection.release();
  }
};

// The money was captured but the order can no longer be fulfilled (it expired
// or an item sold out): refund it and close the order.
const refundAndClose = async (pool, order, paymentId, reason) => {
  try {
    await razorpay.refundPayment(paymentId, order.total_amount);
    // Never rewrite an order that is (still) Paid by another payment: a second,
    // duplicate payment is refunded without touching the valid one.
    await pool.execute(
      `
        UPDATE orders
        SET
          status = 'Cancelled',
          payment_status = 'Refunded',
          payment_id = ?,
          updated_at = UTC_TIMESTAMP(6)
        WHERE id = ?
          AND LOWER(payment_status) NOT IN ('paid', 'partially refunded')
      `,
      [paymentId, order.id]
    );
  } catch (error) {
    console.error(
      "Auto-refund failed | order:",
      order.id,
      "| payment:",
      paymentId,
      "|",
      razorpay.describeError(error)
    );

    // Keep a durable record so the existing admin "Retry / check refund" flow
    // (and the reconcile job) can finish it instead of the refund being lost.
    try {
      await pool.execute(
        `
          UPDATE orders
          SET
            status = 'Cancelled',
            payment_status = 'Refund Pending',
            payment_id = ?,
            updated_at = UTC_TIMESTAMP(6)
          WHERE id = ?
            AND LOWER(payment_status) NOT IN ('paid', 'partially refunded', 'refunded', 'refund pending')
        `,
        [paymentId, order.id]
      );
    } catch (recordError) {
      console.error(
        "Could not record failed auto-refund | order:",
        order.id,
        "|",
        recordError.message
      );
    }
  }
  throw new Error(reason);
};

// An order that already has a refund on record must never trigger another
// refund attempt, however often verify / sync are repeated.
const hasRefundRecord = (order) =>
  ["refunded", "refund pending", "partially refunded"].includes(
    String(order.payment_status).toLowerCase()
  );

const OUT_OF_STOCK_MESSAGE =
  "Sorry, an item sold out while you were paying. Your payment will be refunded.";
const EXPIRED_MESSAGE =
  "This order expired before payment completed. Any amount charged will be refunded.";

const verifyPayment = async ({
  userId,
  orderId,
  razorpayOrderId,
  razorpayPaymentId,
  signature,
}) => {
  const pool = await poolPromise;
  const order = await loadOwnOrder(pool, userId, orderId);

  if (!isOnline(order)) {
    throw new Error("This order is not an online payment order.");
  }

  // Already verified (double submit / retry): report the stored result.
  if (isPaid(order)) {
    if (order.payment_id === razorpayPaymentId) {
      return { orderNumber: order.order_number, status: order.status, paid: true };
    }
    throw new Error("This order is already paid.");
  }

  if (!order.payment_order_id || order.payment_order_id !== razorpayOrderId) {
    throw new Error("Payment does not match this order.");
  }

  if (hasRefundRecord(order)) {
    throw new Error(EXPIRED_MESSAGE);
  }

  const valid = razorpay.verifySignature({
    razorpayOrderId,
    razorpayPaymentId,
    signature,
  });

  if (!valid) {
    await markFailed({ userId, orderId });
    throw new Error("Payment verification failed.");
  }

  const outcome = await finalizePaidOrder(order, razorpayPaymentId);
  confirmByEmail(order, outcome);

  if (outcome === "already_paid") {
    return { orderNumber: order.order_number, status: "Confirmed", paid: true };
  }

  if (outcome === "out_of_stock") {
    await refundAndClose(pool, order, razorpayPaymentId, OUT_OF_STOCK_MESSAGE);
  }

  if (outcome === "skipped") {
    // Cancelled (e.g. expired) while the customer was paying.
    await refundAndClose(pool, order, razorpayPaymentId, EXPIRED_MESSAGE);
  }

  return { orderNumber: order.order_number, status: "Confirmed", paid: true };
};

// Called when checkout is dismissed or the payment fails. Only an unpaid
// Pending order can become Failed, so a paid order can never be downgraded.
const markFailed = async ({ userId, orderId }) => {
  const pool = await poolPromise;

  await pool.execute(
    `
      UPDATE orders
      SET
        payment_status = 'Failed',
        updated_at = UTC_TIMESTAMP(6)
      WHERE id = ?
        AND user_id = ?
        AND LOWER(payment_method) = 'online'
        AND LOWER(payment_status) = 'pending'
    `,
    [orderId, userId]
  );

  return { orderId, paymentStatus: "Failed" };
};

// Asks Razorpay whether this order was actually paid. Covers the case where the
// customer paid but closed the tab before the browser could call /verify.
const syncPayment = async ({ userId, orderId }) => {
  const pool = await poolPromise;
  const order = await loadOwnOrder(pool, userId, orderId);

  if (
    !isOnline(order) ||
    isPaid(order) ||
    ["refunded", "refund pending", "partially refunded"].includes(String(order.payment_status).toLowerCase()) ||
    !order.payment_order_id
  ) {
    return { paid: isPaid(order), status: order.status };
  }

  const payments = await razorpay.fetchOrderPayments(order.payment_order_id);
  const captured = payments.find(
    (payment) =>
      payment.status === "captured" &&
      Number(payment.amount) === razorpay.toPaise(order.total_amount)
  );

  if (!captured) {
    return { paid: false, status: order.status };
  }

  const outcome = await finalizePaidOrder(order, captured.id);
  confirmByEmail(order, outcome);

  if (outcome === "already_paid") {
    return { paid: true, status: "Confirmed" };
  }

  if (outcome === "out_of_stock") {
    await refundAndClose(pool, order, captured.id, OUT_OF_STOCK_MESSAGE);
  }

  if (outcome === "skipped" && order.status === "Cancelled") {
    await refundAndClose(pool, order, captured.id, EXPIRED_MESSAGE);
  }

  return {
    paid: outcome === "paid",
    status: outcome === "paid" ? "Confirmed" : order.status,
  };
};

// Razorpay webhook (payment.captured / order.paid). Covers a customer who paid
// but never came back to the site. Everything is looked up and checked on the
// server: the amount must equal the saved order total, and an order that is
// already paid, refunded or not an online order is left alone, so repeated
// deliveries of the same event are safe.
const settleWebhookPayment = async ({ razorpayOrderId, paymentId, amountPaise }) => {
  if (!razorpayOrderId || !paymentId) {
    return { handled: false, reason: "missing_ids" };
  }

  const pool = await poolPromise;
  const [rows] = await pool.execute(
    `
      SELECT ${ORDER_FIELDS}
      FROM orders
      WHERE payment_order_id = ?
      LIMIT 1
    `,
    [razorpayOrderId]
  );
  const order = rows[0];

  if (!order) return { handled: false, reason: "unknown_order" };
  if (!isOnline(order)) return { handled: false, reason: "not_online" };
  if (isPaid(order)) return { handled: true, outcome: "already_paid" };
  if (hasRefundRecord(order)) return { handled: true, outcome: "refund_on_record" };

  if (Number(amountPaise) !== razorpay.toPaise(order.total_amount)) {
    return { handled: false, reason: "amount_mismatch" };
  }

  const outcome = await finalizePaidOrder(order, paymentId);
  confirmByEmail(order, outcome);

  if (outcome === "out_of_stock" || (outcome === "skipped" && order.status === "Cancelled")) {
    try {
      await refundAndClose(
        pool,
        order,
        paymentId,
        outcome === "out_of_stock" ? OUT_OF_STOCK_MESSAGE : EXPIRED_MESSAGE
      );
    } catch (_reason) {
      // refundAndClose already recorded the order and logged any failure; it
      // rethrows its message only for the customer-facing verify path.
    }
  }

  return { handled: true, outcome };
};

module.exports = {
  settleWebhookPayment,
  createPaymentOrder,
  verifyPayment,
  markFailed,
  syncPayment,
};
