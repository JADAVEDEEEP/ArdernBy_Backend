const crypto = require("crypto");
const { poolPromise } = require("../config/sql");

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

const createOrder = async ({
  userId,
  paymentMethod,
  shippingAddress,
}) => {
  const pool = await poolPromise;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // --------------------------------------
    // 1. GET CART
    // --------------------------------------

    const [cartRows] = await connection.execute(
      `
        SELECT
          id,
          coupon_code
        FROM carts
        WHERE user_id = ?
        LIMIT 1
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
          ci.price_snapshot,

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

        if (
          Boolean(coupon.active) === true &&
          new Date(coupon.expiry) > now &&
          subtotal >= Number(coupon.min_order)
        ) {
          if (
            coupon.discount_type.toLowerCase() ===
            "percentage"
          ) {
            discountAmount =
              subtotal *
              (Number(coupon.discount_value) / 100);

            if (coupon.max_discount !== null) {
              discountAmount = Math.min(
                discountAmount,
                Number(coupon.max_discount)
              );
            }
          } else {
            discountAmount = Number(
              coupon.discount_value
            );
          }

          discountAmount = Math.min(
            discountAmount,
            subtotal
          );
        }
      }
    }

    // --------------------------------------
    // 6. SHIPPING
    // --------------------------------------

    // Subscription/free delivery integration
    // will be added later.

    const shippingAmount = 0;

    // --------------------------------------
    // 7. TAX
    // --------------------------------------

    // Tax integration will be added later.

    const taxAmount = 0;

    // --------------------------------------
    // 8. TOTAL
    // --------------------------------------

    const totalAmount =
      subtotal -
      discountAmount +
      shippingAmount +
      taxAmount;

    // --------------------------------------
    // 9. CREATE ORDER
    // --------------------------------------

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
        "Confirmed",
        paymentMethod,
        "pending",
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
    // --------------------------------------

    for (const item of cartItems) {
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
    // 12. CLEAR CART
    // --------------------------------------

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

    // --------------------------------------
    // COMMIT
    // --------------------------------------

    await connection.commit();

    return {
      id: orderId,
      orderNumber,
      status: "Confirmed",
      paymentMethod,
      paymentStatus: "pending",
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

  return rows;
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

  return {
    ...orderRows[0],
    items: itemRows,
  };
};

// ==========================================
// CANCEL ORDER
// ==========================================

const cancelOrder = async (userId, orderId) => {
  const pool = await poolPromise;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [orderRows] = await connection.execute(
      `
        SELECT
          id,
          status
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

    const order = orderRows[0];

    if (
      ![
        "Confirmed",
        "Processing",
        "Packed",
      ].includes(order.status)
    ) {
      throw new Error(
        "This order cannot be cancelled."
      );
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

    // --------------------------------------
    // RESTORE INVENTORY
    // --------------------------------------

    for (const item of items) {
      await connection.execute(
        `
          UPDATE product_variants
          SET
            inventory = inventory + ?,
            updated_at = UTC_TIMESTAMP(6)
          WHERE id = ?
        `,
        [
          item.quantity,
          item.variant_id,
        ]
      );
    }

    // --------------------------------------
    // UPDATE ORDER
    // --------------------------------------

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

    await connection.commit();

    return {
      id: orderId,
      status: "Cancelled",
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
// GET ALL ORDERS - ADMIN
// ==========================================

const getAllOrders = async () => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
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

  return rows;
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

  const [updateResult] = await pool.execute(
    `
      UPDATE orders
      SET
        status = ?,
        updated_at = UTC_TIMESTAMP(6)
      WHERE id = ?
    `,
    [status, orderId]
  );

  if (updateResult.affectedRows === 0) {
    throw new Error("Order not found.");
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
  getAllOrders,
  updateOrderStatus,
};