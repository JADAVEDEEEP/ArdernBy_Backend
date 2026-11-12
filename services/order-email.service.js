const { poolPromise } = require("../config/sql");
const notifications = require("./notification.service");
const paymentStatus = require("../utils/payment-status");

// ==========================================
// ORDER CONFIRMATION E-MAIL
//
// One e-mail per order, sent only when the order is real:
//   - cash on delivery: as soon as the order is placed (status Confirmed)
//   - online:           only after the payment is verified (status Confirmed and
//                       money held). A pending, failed, cancelled or unpaid online
//                       order never gets one.
//
// It is safe to call this from every place that can confirm an order (customer
// verify, sync, Razorpay webhook): the dedupe key "order-confirmation:<order id>"
// is claimed in notification_log before sending, so repeated calls send nothing.
// This function never throws; an e-mail problem must not touch the order or payment.
// ==========================================

const lc = (value) => String(value || "").trim().toLowerCase();

const isConfirmable = (order) => {
  if (!order || order.status !== "Confirmed") return false;
  const method = lc(order.payment_method);
  if (method === "cod") return true;
  if (method === "online") return paymentStatus.isHeld(order.payment_status);
  return false;
};

const sendOrderConfirmation = async (orderId) => {
  try {
    if (!orderId) return { sent: false, skipped: "no_order" };

    const pool = await poolPromise;
    const [orders] = await pool.execute(
      `
        SELECT
          id, user_id, order_number, status, payment_method, payment_status,
          subtotal, shipping_amount, discount_amount, tax_amount, cod_fee, cod_fee_tax, total_amount,
          coupon_code, created_at,
          shipping_name, shipping_phone, shipping_address, shipping_city,
          shipping_state, shipping_pincode
        FROM orders
        WHERE id = ?
        LIMIT 1
      `,
      [orderId]
    );
    const order = orders[0];

    if (!isConfirmable(order)) return { sent: false, skipped: "not_confirmed" };

    const [items] = await pool.execute(
      `
        SELECT product_name, size, color, quantity, unit_price
        FROM order_items
        WHERE order_id = ?
        ORDER BY created_at, id
      `,
      [orderId]
    );

    return await notifications.notifyUser({
      userId: order.user_id,
      dedupeKey: `order-confirmation:${order.id}`,
      template: "order_confirmation",
      data: {
        orderId: order.id,
        orderNumber: order.order_number,
        placedAt: order.created_at,
        paymentMethod: lc(order.payment_method),
        lines: items.map((item) => ({
          name: item.product_name,
          size: item.size,
          color: item.color,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unit_price),
        })),
        subtotal: Number(order.subtotal),
        shipping: Number(order.shipping_amount),
        discount: Number(order.discount_amount),
        tax: Number(order.tax_amount),
        codFee: Number(order.cod_fee || 0) + Number(order.cod_fee_tax || 0),
        total: Number(order.total_amount),
        couponCode: order.coupon_code,
        shipName: order.shipping_name,
        shipPhone: order.shipping_phone,
        shipAddress: order.shipping_address,
        shipCity: order.shipping_city,
        shipState: order.shipping_state,
        shipPincode: order.shipping_pincode,
      },
    });
  } catch (error) {
    console.error("Order confirmation e-mail failed:", error.code || error.message);
    return { sent: false, failed: true };
  }
};

// "Shipped" / "Delivered" milestone e-mails. Fire-and-forget: never awaited by callers and
// never throws. One e-mail per order and milestone (dedupe key claimed before sending).
const sendOrderStatusEmail = (orderId, status) => {
  const template = { Shipped: "order_shipped", Delivered: "order_delivered" }[status];
  if (!template || !orderId) return Promise.resolve({ sent: false, skipped: "no_template" });

  return (async () => {
    try {
      const pool = await poolPromise;
      const [orders] = await pool.execute(
        "SELECT id, user_id, order_number, status FROM orders WHERE id = ? LIMIT 1",
        [orderId]
      );
      const order = orders[0];
      if (!order || order.status !== status) return { sent: false, skipped: "status_changed" };

      return await notifications.notifyUser({
        userId: order.user_id,
        dedupeKey: `${template.replace("_", "-")}:${order.id}`,
        template,
        data: { orderId: order.id, orderNumber: order.order_number },
      });
    } catch (error) {
      console.error("Order status e-mail failed:", error.code || error.message);
      return { sent: false, failed: true };
    }
  })();
};

// "Payment did not go through" for an online order. Sent once per order.
const sendPaymentFailed = (orderId) =>
  (async () => {
    try {
      const pool = await poolPromise;
      const [orders] = await pool.execute(
        "SELECT id, user_id, order_number, total_amount, payment_status FROM orders WHERE id = ? LIMIT 1",
        [orderId]
      );
      const order = orders[0];
      if (!order || String(order.payment_status).toLowerCase() !== "failed") return { sent: false, skipped: "not_failed" };

      return await notifications.notifyUser({
        userId: order.user_id,
        dedupeKey: `payment-failed:${order.id}`,
        template: "payment_failed",
        data: { orderId: order.id, orderNumber: order.order_number, amount: Number(order.total_amount) },
      });
    } catch (error) {
      console.error("Payment failed e-mail error:", error.code || error.message);
      return { sent: false, failed: true };
    }
  })();

module.exports = { sendOrderConfirmation, sendOrderStatusEmail, sendPaymentFailed, isConfirmable };
