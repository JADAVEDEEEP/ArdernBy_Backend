const crypto = require("crypto");
const razorpay = require("./razorpay.service");
const { poolPromise } = require("../config/sql");
const {
  calculateCouponDiscount,
  calculateOrderTotals,
} = require("../utils/pricing");

// ==========================================
// GENERATE ORDER NUMBER
// ==========================================

const generateOrderNumber = () => {
  const timestamp = Date.now().toString().slice(-8);
  const random = crypto.randomInt(1000, 9999);

  return `ARD-${timestamp}-${random}`;
};

// ==========================================
// CREATE ORDER
// ==========================================

const PAYMENT_METHODS = ["cod", "online"];

const createOrder = async ({
  userId,
  paymentMethod,
  shippingAddress,
}) => {
  const method = String(paymentMethod || "").toLowerCase();

  if (!PAYMENT_METHODS.includes(method)) {
    throw new Error("Unsupported payment method.");
  }

  const isOnline = method === "online";

  const pool = await poolPromise;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // --------------------------------------
    // 1. GET CART (locked, so a double-click
    //    or a second tab cannot create two
    //    orders from the same cart)
    // --------------------------------------

    const [cartRows] = await connection.execute(
      `
        SELECT
          id,
          coupon_code
        FROM carts
        WHERE user_id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [userId]
    );

    if (cartRows.length === 0) {
      throw new Error("Cart not found.");
    }

    const cart = cartRows[0];

    // --------------------------------------
    // 2. GET CART ITEMS
    // --------------------------------------

    const [cartItems] = await connection.execute(
      `
        SELECT
          ci.id,
          ci.variant_id,
          ci.quantity,
          p.price AS price_snapshot,

          p.id AS product_id,
          p.name AS product_name,
          p.mrp AS product_mrp,

          (
            SELECT pi.image_url
            FROM product_images pi
            WHERE pi.product_id = p.id
              AND pi.is_primary = 1
            ORDER BY pi.sort_order ASC
            LIMIT 1
          ) AS product_image,

          pv.size,
          pv.color,
          pv.inventory

        FROM cart_items ci

        INNER JOIN products p
          ON p.id = ci.product_id

        INNER JOIN product_variants pv
          ON pv.id = ci.variant_id

        WHERE ci.cart_id = ?
      `,
      [cart.id]
    );

    if (cartItems.length === 0) {
      throw new Error("Cart is empty.");
    }

    // --------------------------------------
    // 3. CHECK INVENTORY
    // --------------------------------------

    for (const item of cartItems) {
      if (item.inventory < item.quantity) {
        throw new Error(
          `Insufficient inventory for ${item.product_name} (${item.size}/${item.color}).`
        );
      }
    }

    // --------------------------------------
    // 4. CALCULATE SUBTOTAL
    // --------------------------------------

    const subtotal = cartItems.reduce(
      (total, item) =>
        total +
        Number(item.price_snapshot) * item.quantity,
      0
    );

    // --------------------------------------
    // 5. COUPON
    // --------------------------------------

    let discountAmount = 0;

    if (cart.coupon_code) {
      const [couponRows] = await connection.execute(
        `
          SELECT
            code,
            discount_type,
            discount_value,
            min_order,
            max_discount,
            expiry,
            active
          FROM coupons
          WHERE code = ?
          LIMIT 1
        `,
        [cart.coupon_code]
      );

      if (couponRows.length > 0) {
        const coupon = couponRows[0];

        const now = new Date();

        // A coupon with no expiry date never expires.
        const notExpired =
          coupon.expiry == null || new Date(coupon.expiry) > now;

        if (
          Boolean(coupon.active) === true &&
          notExpired &&
          subtotal >= Number(coupon.min_order)
        ) {
          discountAmount = calculateCouponDiscount(
            coupon,
            subtotal
          );
        }
      }
    }

    // --------------------------------------
    // 6. SHIPPING, TAX (GST) AND TOTAL
    // --------------------------------------

    // Same rules as the cart drawer / checkout (utils/pricing.js).
    const {
      shippingAmount,
      taxAmount,
      totalAmount,
    } = calculateOrderTotals(subtotal, discountAmount);

    // --------------------------------------
    // 9. CREATE ORDER
    // --------------------------------------

    // A retry must not leave duplicate unpaid orders behind: older unpaid
    // online orders of this customer are closed (they hold no stock).
    if (isOnline) {
      await connection.execute(
        `
          UPDATE orders
          SET
            status = 'Cancelled',
            updated_at = UTC_TIMESTAMP(6)
          WHERE user_id = ?
            AND LOWER(payment_method) = 'online'
            AND status = 'Processing'
            AND LOWER(payment_status) IN ('pending', 'failed')
        `,
        [userId]
      );
    }

    const orderId = crypto.randomUUID();
    const orderNumber = generateOrderNumber();

    await connection.execute(
      `
        INSERT INTO orders (
          id,
          user_id,
          order_number,
          status,
          payment_method,
          payment_status,
          subtotal,
          shipping_amount,
          discount_amount,
          tax_amount,
          total_amount,
          coupon_code,
          shipping_name,
          shipping_phone,
          shipping_pincode,
          shipping_address,
          shipping_city,
          shipping_state,
          created_at,
          updated_at
        )
        VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          UTC_TIMESTAMP(6),
          UTC_TIMESTAMP(6)
        )
      `,
      [
        orderId,
        userId,
        orderNumber,
        // Online orders stay "Processing" until the payment is verified.
        isOnline ? "Processing" : "Confirmed",
        method,
        "Pending",
        subtotal,
        shippingAmount,
        discountAmount,
        taxAmount,
        totalAmount,
        cart.coupon_code || null,
        shippingAddress.name,
        shippingAddress.phone,
        shippingAddress.pincode,
        shippingAddress.address,
        shippingAddress.city,
        shippingAddress.state,
      ]
    );

    // --------------------------------------
    // 10. CREATE ORDER ITEMS
    // --------------------------------------

    for (const item of cartItems) {
      const orderItemId = crypto.randomUUID();

      await connection.execute(
        `
          INSERT INTO order_items (
            id,
            order_id,
            product_id,
            variant_id,
            product_name,
            product_image,
            size,
            color,
            quantity,
            unit_price,
            unit_mrp,
            created_at
          )
          VALUES (
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            UTC_TIMESTAMP(6)
          )
        `,
        [
          orderItemId,
          orderId,
          item.product_id,
          item.variant_id,
          item.product_name,
          item.product_image || null,
          item.size,
          item.color,
          item.quantity,
          Number(item.price_snapshot),
          Number(item.product_mrp),
        ]
      );
    }

    // --------------------------------------
    // 11. REDUCE INVENTORY
    //     COD takes stock now. Online orders take stock
    //     only once the payment is verified
    //     (payment.service finalizePaidOrder).
    // --------------------------------------

    for (const item of isOnline ? [] : cartItems) {
      const [inventoryResult] =
        await connection.execute(
          `
            UPDATE product_variants
            SET
              inventory = inventory - ?,
              updated_at = UTC_TIMESTAMP(6)
            WHERE id = ?
              AND inventory >= ?
          `,
          [
            item.quantity,
            item.variant_id,
            item.quantity,
          ]
        );

      if (inventoryResult.affectedRows === 0) {
        throw new Error(
          `Unable to update inventory for ${item.product_name}.`
        );
      }
    }

    // --------------------------------------
    // 12. CLEAR CART (COD only - an online cart
    //     is kept until payment succeeds, so a
    //     failed or cancelled payment loses nothing)
    // --------------------------------------

    if (!isOnline) {
      await connection.execute(
        `
          DELETE FROM cart_items
          WHERE cart_id = ?
        `,
        [cart.id]
      );

      await connection.execute(
        `
          UPDATE carts
          SET
            coupon_code = NULL,
            updated_at = UTC_TIMESTAMP(6)
          WHERE id = ?
        `,
        [cart.id]
      );
    }

    // --------------------------------------
    // COMMIT
    // --------------------------------------

    await connection.commit();

    return {
      id: orderId,
      orderNumber,
      status: isOnline ? "Processing" : "Confirmed",
      paymentMethod: method,
      paymentStatus: "Pending",
      subtotal,
      shippingAmount,
      discountAmount,
      taxAmount,
      totalAmount,
      couponCode: cart.coupon_code || null,
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}

    throw error;
  } finally {
    connection.release();
  }
};

// ==========================================
// GET MY ORDERS
// ==========================================

const getMyOrders = async (userId) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        order_number,
        status,
        payment_method,
        payment_status,
        subtotal,
        shipping_amount,
        discount_amount,
        tax_amount,
        total_amount,
        coupon_code,
        created_at,
        updated_at
      FROM orders
      WHERE user_id = ?
      ORDER BY created_at DESC
    `,
    [userId]
  );

  return rows.map(customerView);
};

// ==========================================
// GET ORDER BY ID
// ==========================================

const getOrderById = async (userId, orderId) => {
  const pool = await poolPromise;

  const [orderRows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        order_number,
        status,
        payment_method,
        payment_status,
        subtotal,
        shipping_amount,
        discount_amount,
        tax_amount,
        total_amount,
        coupon_code,
        shipping_name,
        shipping_phone,
        shipping_pincode,
        shipping_address,
        shipping_city,
        shipping_state,
        payment_order_id,
        payment_id,
        shiprocket_order_id,
        shiprocket_shipment_id,
        created_at,
        updated_at
      FROM orders
      WHERE id = ?
        AND user_id = ?
      LIMIT 1
    `,
    [orderId, userId]
  );

  if (orderRows.length === 0) {
    throw new Error("Order not found.");
  }

  const [itemRows] = await pool.execute(
    `
      SELECT
        id,
        product_id,
        variant_id,
        product_name,
        product_image,
        size,
        color,
        quantity,
        unit_price,
        unit_mrp,
        created_at
      FROM order_items
      WHERE order_id = ?
      ORDER BY created_at ASC
    `,
    [orderId]
  );

  // Internal bookkeeping (account id, courier ids) is not part of the customer's view.
  const {
    user_id: _userId,
    shiprocket_order_id: _shiprocketOrderId,
    shiprocket_shipment_id: _shiprocketShipmentId,
    ...visible
  } = customerView(orderRows[0]);

  return {
    ...visible,
    items: itemRows,
  };
};

// ==========================================
// CANCEL ORDER
// ==========================================

// ----- cancellation model --------------------------------------------------
//
// A customer cancel that passes the eligibility rules is ALWAYS approved: the
// order becomes "Cancelled" and stock is restored. The money side is tracked
// internally on order.payment_status (paid online orders only):
//   Paid -> Refunded                 Razorpay confirmed the refund is processed
//   Paid -> Refund Pending           refund not (yet) confirmed: Razorpay accepted
//                                    it but has not processed it, OR it could not
//                                    be started (low balance, rejection, outage).
//                                    An admin retries it; retrying first reconciles
//                                    with Razorpay's own refund list, so it can
//                                    never create a second refund.
//   "Refunded" is only ever written when Razorpay says the refund is processed.
// Customers never see "Refund Pending" (see customerView); admins do.
//
// "Cancellation Requested" is the legacy state from the earlier workflow (order
// held open, nothing cancelled). No new orders enter it; existing ones are
// completed by the admin retry.
const CANCELLATION_REQUESTED = "Cancellation Requested";
const CUSTOMER_CANCELLABLE_STATUSES = ["Pending", "Confirmed", "Processing"];
// Admins and the system (expired unpaid orders) may also cancel a Packed order,
// and complete a pending cancellation request.
const ADMIN_CANCELLABLE_STATUSES = [
  ...CUSTOMER_CANCELLABLE_STATUSES,
  "Packed",
  CANCELLATION_REQUESTED,
];

const CANCEL_BLOCKED_MESSAGE =
  "Sorry, this order can no longer be cancelled because it has moved beyond the processing stage.";
const ALREADY_CANCELLED_MESSAGE = "This order has already been cancelled.";
const REFUND_PENDING = "Refund Pending";
const REFUNDED = "Refunded";

// Error carrying an HTTP status (and optional machine code) so the controller
// can answer precisely.
const orderError = (message, statusCode, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

const sameStatus = (a, b) =>
  String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

const rupees = (paise) =>
  "₹" + (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 });

// Decides WHY Razorpay refused a refund. Never assumes: a vague HTTP 400 is only
// called a balance problem when the account balance is confirmed to be short.
//   already_refunded     Razorpay already holds a full refund for this payment
//   insufficient_balance not enough account balance to fund the refund
//   other                anything else (logged and surfaced separately)
const classifyRefundFailure = async (error, requiredPaise) => {
  const message = error?.message || "";

  if (
    /already\s+(been\s+)?(fully\s+)?refunded|fully\s+refunded|refund\s+has\s+already\s+been\s+processed/i.test(
      message
    )
  ) {
    return { kind: "already_refunded" };
  }

  if (/enough\s+balance|insufficient\s+balance/i.test(message)) {
    const balancePaise = await razorpay.fetchBalancePaise();
    return { kind: "insufficient_balance", inferred: false, balancePaise };
  }

  // Razorpay sometimes masks a short balance as a generic 400 (code
  // BAD_REQUEST_ERROR, reason/source/step "NA"). Only believe it if the
  // balance really is lower than the refund.
  if (
    error?.razorpay?.httpStatus === 400 &&
    /invalid\s+request\s+sent/i.test(message)
  ) {
    const balancePaise = await razorpay.fetchBalancePaise();

    if (balancePaise !== null && balancePaise < requiredPaise) {
      return { kind: "insufficient_balance", inferred: true, balancePaise };
    }
  }

  return { kind: "other" };
};

// Starts the refund for a paid online order. Safe to call again for the same
// order: it first looks at what Razorpay already holds for the payment, so a
// retry (after a lost answer, a failed DB write, or an admin retry) can never
// create a second refund.
//
// Resolves with
//   { outcome: "refunded", refundId, refundStatus: "processed" | "pending" }
//   { outcome: "deferred", reason, code, statusCode, message }
// "deferred" means the refund could not be started right now (low balance, a
// rejection, a partial refund needing review). Nothing was refunded; the caller
// keeps an internal Refund Pending record for the admin to retry.
const deferred = (reason, code, statusCode, message) => ({
  outcome: "deferred",
  reason,
  code,
  statusCode,
  message,
});

const initiateRefund = async (order) => {
  const requiredPaise = razorpay.toPaise(order.total_amount);

  // 1) Idempotency: adopt a refund that already exists instead of making another.
  const existing = await razorpay.fetchPaymentRefunds(order.payment_id);

  if (existing) {
    const live = existing.filter(
      (r) => String(r.status).toLowerCase() !== "failed"
    );
    const refundedPaise = live.reduce(
      (sum, r) => sum + Number(r.amount || 0),
      0
    );

    if (refundedPaise >= requiredPaise) {
      const allProcessed = live.every(
        (r) => String(r.status).toLowerCase() === "processed"
      );

      return {
        outcome: "refunded",
        refundId: live[0]?.id || null,
        refundStatus: allProcessed ? "processed" : "pending",
      };
    }

    if (refundedPaise > 0) {
      console.error(
        "Cancel refund blocked | order:",
        order.id,
        "| payment:",
        order.payment_id,
        "| a PARTIAL refund already exists (" +
          refundedPaise +
          " of " +
          requiredPaise +
          " paise); review it in the Razorpay dashboard"
      );
      return deferred(
        "partial_refund",
        "PARTIAL_REFUND_EXISTS",
        409,
        "This payment already has a partial refund, so it needs a manual review in the Razorpay dashboard."
      );
    }
  }

  // 2) Create the refund.
  let refund;

  try {
    refund = await razorpay.refundPayment(order.payment_id, order.total_amount);
  } catch (error) {
    const failure = await classifyRefundFailure(error, requiredPaise);

    if (failure.kind === "already_refunded") {
      // Razorpay holds a refund but we could not read its state: never claim
      // it is processed.
      console.warn(
        "Cancel refund | order:",
        order.id,
        "| Razorpay reports the payment is already refunded; adopting it as pending"
      );
      return { outcome: "refunded", refundId: null, refundStatus: "pending" };
    }

    if (failure.kind === "insufficient_balance") {
      console.warn(
        "Cancel refund DEFERRED (insufficient Razorpay balance) | order:",
        order.id,
        "| payment:",
        order.payment_id,
        "| balance:",
        failure.balancePaise === null ? "unknown" : failure.balancePaise + " paise",
        "| refund:",
        requiredPaise + " paise",
        failure.inferred
          ? "| inferred from a generic HTTP 400"
          : "| stated by Razorpay",
        "|",
        razorpay.describeError(error)
      );
      return deferred(
        "insufficient_balance",
        "INSUFFICIENT_BALANCE",
        409,
        failure.balancePaise === null
          ? "Razorpay could not fund this refund (the account balance could not be read). Add funds and retry."
          : "Razorpay balance " +
              rupees(failure.balancePaise) +
              " is lower than this refund (" +
              rupees(requiredPaise) +
              "). Add funds, then retry."
      );
    }

    // Any other rejection: keep the details for the operator, tell the customer
    // nothing internal, and leave the order exactly as it was.
    console.error(
      "Cancel refund REJECTED (not a balance problem) | order:",
      order.id,
      "| payment:",
      order.payment_id,
      "|",
      razorpay.describeError(error)
    );
    return deferred(
      "rejected",
      "REFUND_REJECTED",
      502,
      "Razorpay did not accept the refund (see the server log for details). Try again in a moment."
    );
  }

  if (String(refund?.status).toLowerCase() === "failed") {
    console.error(
      "Cancel refund came back FAILED | order:",
      order.id,
      "| payment:",
      order.payment_id,
      "| refund:",
      refund?.id
    );
    return deferred(
      "refund_failed",
      "REFUND_REJECTED",
      502,
      "Razorpay created the refund but marked it failed. Check the Razorpay dashboard, then retry."
    );
  }

  return {
    outcome: "refunded",
    refundId: refund?.id || null,
    // Only a refund Razorpay reports as processed counts as refunded.
    refundStatus:
      String(refund?.status).toLowerCase() === "processed"
        ? "processed"
        : "pending",
  };
};

// Cancels one order inside a transaction: restores stock exactly once and
// refunds a verified online payment. `userId` is null for admin / system use.
//
// The order row is locked (FOR UPDATE) for the whole transaction, so two
// simultaneous requests can never both pass the status check: the second one
// waits, then sees the new status and is rejected (no double stock restore, no
// double refund).
//
// Paid online order, customer request, refund cannot be funded right now:
// the order moves to "Cancellation Requested" (nothing is cancelled or marked
// refunded) and an admin completes it later with the same function.
const cancelOrderById = async (orderId, { userId = null, reason } = {}) => {
  const pool = await poolPromise;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [orderRows] = await connection.execute(
      `
        SELECT
          id,
          status,
          payment_method,
          payment_status,
          payment_id,
          total_amount
        FROM orders
        WHERE id = ?
          ${userId ? "AND user_id = ?" : ""}
        LIMIT 1
        FOR UPDATE
      `,
      userId ? [orderId, userId] : [orderId]
    );

    // Ownership is part of the query: someone else's order looks like a
    // missing one, so order ids cannot be probed.
    if (orderRows.length === 0) {
      throw orderError("Order not found.", 404);
    }

    const order = orderRows[0];

    if (sameStatus(order.status, "Cancelled")) {
      throw orderError(ALREADY_CANCELLED_MESSAGE, 409, "ALREADY_CANCELLED");
    }

    // Legacy "Cancellation Requested" order: the customer already asked; only
    // an admin completes it.
    if (userId && sameStatus(order.status, CANCELLATION_REQUESTED)) {
      throw orderError(ALREADY_CANCELLED_MESSAGE, 409, "ALREADY_CANCELLED");
    }

    const allowed = userId
      ? CUSTOMER_CANCELLABLE_STATUSES
      : ADMIN_CANCELLABLE_STATUSES;

    if (!allowed.some((status) => sameStatus(status, order.status))) {
      throw orderError(
        userId ? CANCEL_BLOCKED_MESSAGE : "This order cannot be cancelled.",
        409,
        "NOT_CANCELLABLE"
      );
    }

    const isOnlineOrder =
      String(order.payment_method).toLowerCase() === "online";
    const isPaidOnline =
      isOnlineOrder && String(order.payment_status).toLowerCase() === "paid";

    if (isPaidOnline && !order.payment_id) {
      throw orderError(
        "Cannot refund this order because its payment reference is missing. Please contact support.",
        409,
        "PAYMENT_REFERENCE_MISSING"
      );
    }

    // COD (and unpaid online) orders never touch Razorpay: nothing to refund.
    let refundId = null;
    let refundStatus = "none"; // none | processed | pending | queued
    let paymentStatus = order.payment_status;

    if (isPaidOnline) {
      // The refund is started BEFORE any database change. initiateRefund is
      // idempotent, so if the writes below ever fail after the refund was
      // accepted, retrying adopts that refund instead of creating a second one.
      const result = await initiateRefund(order);

      if (result.outcome === "deferred") {
        // The cancellation is still approved. Keep a durable internal record so
        // an admin can retry; nothing is marked refunded.
        console.warn(
          "Refund DEFERRED, kept as Refund Pending | order:",
          orderId,
          "| reason:",
          result.reason,
          "|",
          result.message
        );
        refundId = null;
        refundStatus = "queued";
        paymentStatus = REFUND_PENDING;
      } else {
        refundId = result.refundId;
        refundStatus = result.refundStatus;
        paymentStatus =
          refundStatus === "processed" ? REFUNDED : REFUND_PENDING;
      }
    }

    const [items] = await connection.execute(
      `
        SELECT
          variant_id,
          quantity
        FROM order_items
        WHERE order_id = ?
      `,
      [orderId]
    );

    // Stock is only taken for COD orders and for verified-paid online orders.
    const stockWasTaken = !(
      isOnlineOrder &&
      !["paid", "refunded", "refund pending"].includes(
        String(order.payment_status).toLowerCase()
      )
    );

    try {
      for (const item of stockWasTaken ? items : []) {
        if (!item.variant_id) continue;

        await connection.execute(
          `
            UPDATE product_variants
            SET
              inventory = inventory + ?,
              updated_at = UTC_TIMESTAMP(6)
            WHERE id = ?
          `,
          [item.quantity, item.variant_id]
        );
      }

      await connection.execute(
        `
          UPDATE orders
          SET
            status = 'Cancelled',
            updated_at = UTC_TIMESTAMP(6)
          WHERE id = ?
        `,
        [orderId]
      );

      if (isPaidOnline) {
        await connection.execute(
          `
            UPDATE orders
            SET
              payment_status = ?,
              updated_at = UTC_TIMESTAMP(6)
            WHERE id = ?
          `,
          [paymentStatus, orderId]
        );
      }
    } catch (error) {
      if (isPaidOnline) {
        console.error(
          "REFUND ACCEPTED BUT ORDER UPDATE FAILED — retrying the cancel adopts the existing refund:",
          orderId,
          refundId,
          error.message
        );
      }
      throw error;
    }

    await connection.commit();

    return {
      id: orderId,
      status: "Cancelled",
      paymentStatus,
      refundId,
      refundStatus,
      refundAmount: refundStatus === "none" ? null : Number(order.total_amount),
      reason: reason || null,
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}

    throw error;
  } finally {
    connection.release();
  }
};

const cancelOrder = (userId, orderId) => cancelOrderById(orderId, { userId });

// Admin: retry the refund of a cancelled order that is still "Refund Pending"
// (or complete a legacy "Cancellation Requested" order). Locked and idempotent:
// initiateRefund first reads Razorpay's own refund list, so an existing refund is
// adopted (and marked Refunded only if Razorpay says processed) instead of a
// second one being created. Stock is never touched for an already-cancelled order.
const retryCancellationRefund = async (orderId) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    "SELECT status, payment_status FROM orders WHERE id = ? LIMIT 1",
    [orderId]
  );

  if (rows.length === 0) {
    throw orderError("Order not found.", 404);
  }

  const { status, payment_status: paymentStatus } = rows[0];

  if (sameStatus(status, CANCELLATION_REQUESTED)) {
    return cancelOrderById(orderId, {
      reason: "Pending cancellation completed by admin.",
    });
  }

  if (sameStatus(status, "Cancelled") && sameStatus(paymentStatus, REFUND_PENDING)) {
    return retryPendingRefund(orderId);
  }

  if (sameStatus(status, "Cancelled")) {
    throw orderError(
      sameStatus(paymentStatus, REFUNDED)
        ? "This refund is already complete."
        : "This cancelled order has no refund to retry.",
      409,
      "NO_PENDING_REFUND"
    );
  }

  throw orderError(
    "This order has no pending refund.",
    409,
    "NO_PENDING_CANCELLATION"
  );
};

const retryPendingRefund = async (orderId) => {
  const pool = await poolPromise;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [orderRows] = await connection.execute(
      `
        SELECT
          id,
          status,
          payment_method,
          payment_status,
          payment_id,
          total_amount
        FROM orders
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [orderId]
    );

    const order = orderRows[0];

    if (!order) {
      throw orderError("Order not found.", 404);
    }

    // Re-checked under the lock: a concurrent retry may have just finished.
    if (
      !sameStatus(order.status, "Cancelled") ||
      !sameStatus(order.payment_status, REFUND_PENDING) ||
      String(order.payment_method).toLowerCase() !== "online"
    ) {
      throw orderError(
        "This order has no pending refund.",
        409,
        "NO_PENDING_REFUND"
      );
    }

    if (!order.payment_id) {
      throw orderError(
        "Cannot refund this order because its payment reference is missing.",
        409,
        "PAYMENT_REFERENCE_MISSING"
      );
    }

    const result = await initiateRefund(order);

    if (result.outcome === "deferred") {
      console.warn(
        "Refund retry still DEFERRED | order:",
        orderId,
        "| reason:",
        result.reason,
        "|",
        result.message
      );
      throw orderError(result.message, result.statusCode, result.code);
    }

    const paymentStatus =
      result.refundStatus === "processed" ? REFUNDED : REFUND_PENDING;

    await connection.execute(
      `
        UPDATE orders
        SET
          payment_status = ?,
          updated_at = UTC_TIMESTAMP(6)
        WHERE id = ?
      `,
      [paymentStatus, orderId]
    );

    await connection.commit();

    return {
      id: orderId,
      status: "Cancelled",
      paymentStatus,
      refundId: result.refundId,
      refundStatus: result.refundStatus,
      refundAmount: Number(order.total_amount),
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}

    throw error;
  } finally {
    connection.release();
  }
};

// Read-only reconciliation: looks at what Razorpay holds for cancelled orders
// still marked Refund Pending and records "Refunded" ONLY where a full refund is
// confirmed processed. It never creates a refund and never changes anything else.
// `apply: false` reports without writing. Returns one row per order examined.
const reconcilePendingRefunds = async ({ apply = true, orderId = null } = {}) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT id, order_number, payment_id, total_amount
      FROM orders
      WHERE LOWER(status) = 'cancelled'
        AND LOWER(payment_status) = 'refund pending'
        AND payment_id IS NOT NULL
      LIMIT 100
    `
  );

  const report = [];

  for (const order of rows) {
    if (orderId && order.id !== orderId) continue;

    const refunds = await razorpay.fetchPaymentRefunds(order.payment_id);
    const requiredPaise = razorpay.toPaise(order.total_amount);
    let outcome = "unchanged";

    if (refunds === null) {
      outcome = "razorpay_unreadable";
    } else {
      const live = refunds.filter(
        (r) => String(r.status).toLowerCase() !== "failed"
      );
      const total = live.reduce((sum, r) => sum + Number(r.amount || 0), 0);
      const confirmed =
        live.length > 0 &&
        total >= requiredPaise &&
        live.every((r) => String(r.status).toLowerCase() === "processed");

      if (confirmed) {
        outcome = apply ? "marked_refunded" : "would_mark_refunded";

        if (apply) {
          await pool.execute(
            `
              UPDATE orders
              SET
                payment_status = 'Refunded',
                updated_at = UTC_TIMESTAMP(6)
              WHERE id = ?
                AND payment_status = 'Refund Pending'
            `,
            [order.id]
          );
        }
      }
    }

    report.push({
      id: order.id,
      orderNumber: order.order_number,
      outcome,
    });
  }

  return report;
};

// What a customer is allowed to see. Cancellation is final from their side:
// the legacy "Cancellation Requested" state reads as Cancelled, and the internal
// refund bookkeeping (Refund Pending / Refunded) is never exposed.
const customerView = (order) => {
  const cancelled =
    sameStatus(order.status, "Cancelled") ||
    sameStatus(order.status, CANCELLATION_REQUESTED);

  if (!cancelled) return order;

  const isRefundState =
    sameStatus(order.payment_status, REFUND_PENDING) ||
    sameStatus(order.payment_status, REFUNDED) ||
    sameStatus(order.status, CANCELLATION_REQUESTED);

  return {
    ...order,
    status: "Cancelled",
    payment_status: isRefundState ? "Cancelled" : order.payment_status,
  };
};

// Tidy up unpaid online orders the customer abandoned (they hold no stock).
const UNPAID_ORDER_TTL_MINUTES = 30;

const releaseExpiredUnpaidOrders = async () => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT id
      FROM orders
      WHERE payment_method = 'online'
        AND payment_status IN ('Pending', 'Failed')
        AND status = 'Processing'
        AND created_at < (UTC_TIMESTAMP() - INTERVAL ? MINUTE)
      LIMIT 50
    `,
    [UNPAID_ORDER_TTL_MINUTES]
  );

  let released = 0;

  for (const row of rows) {
    try {
      await cancelOrderById(row.id, { reason: "Payment not completed." });
      released += 1;
    } catch (error) {
      console.error("Release unpaid order failed:", row.id, error.message);
    }
  }

  return released;
};

// ==========================================
// GET ALL ORDERS - ADMIN
// ==========================================

const getAllOrders = async () => {
  const pool = await poolPromise;

  const [orders] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        order_number,
        status,
        payment_method,
        payment_status,
        subtotal,
        shipping_amount,
        discount_amount,
        tax_amount,
        total_amount,
        coupon_code,
        shipping_name,
        shipping_phone,
        shipping_pincode,
        shipping_address,
        shipping_city,
        shipping_state,
        payment_order_id,
        payment_id,
        shiprocket_order_id,
        shiprocket_shipment_id,
        created_at,
        updated_at
      FROM orders
      ORDER BY created_at DESC
    `
  );

  if (orders.length === 0) {
    return [];
  }

  const orderIds = orders.map((order) => order.id);

  const placeholders = orderIds.map(() => "?").join(", ");

  const [items] = await pool.execute(
    `
      SELECT
        id,
        order_id,
        product_id,
        variant_id,
        product_name,
        product_image,
        size,
        color,
        quantity,
        unit_price,
        unit_mrp,
        created_at
      FROM order_items
      WHERE order_id IN (${placeholders})
      ORDER BY created_at ASC
    `,
    orderIds
  );

  const itemsByOrder = {};

  for (const item of items) {
    if (!itemsByOrder[item.order_id]) {
      itemsByOrder[item.order_id] = [];
    }

    itemsByOrder[item.order_id].push({
      id: item.id,
      product_id: item.product_id,
      variant_id: item.variant_id,

      product_name: item.product_name,
      product_image: item.product_image,

      size: item.size,
      color: item.color,

      quantity: Number(item.quantity || 0),

      unit_price: Number(item.unit_price || 0),
      unit_mrp: Number(item.unit_mrp || 0),

      total:
        Number(item.unit_price || 0) *
        Number(item.quantity || 0),

      created_at: item.created_at,
    });
  }

  return orders.map((order) => ({
    ...order,

    items: itemsByOrder[order.id] || [],
  }));
};

// ==========================================
// UPDATE ORDER STATUS - ADMIN
// ==========================================

const updateOrderStatus = async (
  orderId,
  status
) => {
  const allowedStatuses = [
    "Confirmed",
    "Processing",
    "Packed",
    "Shipped",
    "Delivered",
    "Cancelled",
    "Returned",
  ];

  if (!allowedStatuses.includes(status)) {
    throw new Error("Invalid order status.");
  }

  const pool = await poolPromise;

  const [currentRows] = await pool.execute(
    `
      SELECT
        status,
        payment_method,
        payment_status
      FROM orders
      WHERE id = ?
      LIMIT 1
    `,
    [orderId]
  );

  if (currentRows.length === 0) {
    throw new Error("Order not found.");
  }

  const current = currentRows[0];

  if (current.status === "Cancelled") {
    throw new Error("A cancelled order cannot be changed.");
  }

  // The customer asked to cancel and the refund is still outstanding: the only
  // way forward is completing the cancellation (retry the refund).
  if (sameStatus(current.status, CANCELLATION_REQUESTED) && status !== "Cancelled") {
    throw orderError(
      "This order has a pending cancellation request. Retry the refund to complete the cancellation instead of changing its status.",
      409,
      "CANCELLATION_PENDING"
    );
  }

  // Cancelling must restore stock (and refund a paid online order).
  if (status === "Cancelled") {
    await cancelOrderById(orderId);
  } else {
    const unpaidOnline =
      String(current.payment_method).toLowerCase() === "online" &&
      String(current.payment_status).toLowerCase() !== "paid";

    if (unpaidOnline && status !== "Processing") {
      throw new Error("This online order has not been paid yet.");
    }

    // Only applies if the order is still in the status that was checked above.
    // A customer cancel (or another admin) that landed in between wins, so a
    // cancelled order can never be pushed back to Shipped / Delivered.
    const [updateResult] = await pool.execute(
      `
        UPDATE orders
        SET
          status = ?,
          payment_status = CASE
            WHEN ? = 'Delivered'
              AND LOWER(payment_method) = 'cod'
              AND LOWER(payment_status) = 'pending'
            THEN 'Paid'
            ELSE payment_status
          END,
          updated_at = UTC_TIMESTAMP(6)
        WHERE id = ?
          AND status = ?
      `,
      [status, status, orderId, current.status]
    );

    if (updateResult.affectedRows === 0) {
      throw orderError(
        "This order was just changed by someone else. Refresh and try again.",
        409,
        "ORDER_CHANGED"
      );
    }
  }

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        order_number,
        status,
        payment_status,
        total_amount,
        updated_at
      FROM orders
      WHERE id = ?
      LIMIT 1
    `,
    [orderId]
  );

  if (rows.length === 0) {
    throw new Error("Order not found.");
  }

  return rows[0];
};

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  createOrder,
  getMyOrders,
  getOrderById,
  cancelOrder,
  cancelOrderById,
  retryCancellationRefund,
  reconcilePendingRefunds,
  customerView,
  releaseExpiredUnpaidOrders,
  getAllOrders,
  updateOrderStatus,
};
