const crypto = require("crypto");
const { sql, poolPromise } = require("../config/sql");


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
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // --------------------------------------
    // 1. GET CART
    // --------------------------------------

    const cartResult = await transaction
      .request()
      .input("userId", sql.UniqueIdentifier, userId)
      .query(`
        SELECT
          id,
          coupon_code
        FROM carts
        WHERE user_id = @userId
      `);

    if (cartResult.recordset.length === 0) {
      throw new Error("Cart not found.");
    }

    const cart = cartResult.recordset[0];


    // --------------------------------------
    // 2. GET CART ITEMS
    // --------------------------------------

    const itemsResult = await transaction
      .request()
      .input("cartId", sql.UniqueIdentifier, cart.id)
      .query(`
        SELECT
          ci.id,
          ci.variant_id,
          ci.quantity,
          ci.price_snapshot,

          p.id AS product_id,
          p.name AS product_name,
          p.mrp AS product_mrp,

          pi.image_url AS product_image,

          pv.size,
          pv.color,
          pv.inventory

        FROM cart_items ci

        INNER JOIN products p
          ON p.id = ci.product_id

        INNER JOIN product_variants pv
          ON pv.id = ci.variant_id

        OUTER APPLY (
          SELECT TOP 1
            image_url
          FROM product_images
          WHERE product_id = p.id
            AND is_primary = 1
          ORDER BY sort_order ASC
        ) pi

        WHERE ci.cart_id = @cartId
      `);

    if (itemsResult.recordset.length === 0) {
      throw new Error("Cart is empty.");
    }

    const cartItems = itemsResult.recordset;


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
        total + Number(item.price_snapshot) * item.quantity,
      0
    );


    // --------------------------------------
    // 5. COUPON
    // --------------------------------------

    let discountAmount = 0;

    if (cart.coupon_code) {
      const couponResult = await transaction
        .request()
        .input(
          "code",
          sql.NVarChar(100),
          cart.coupon_code
        )
        .query(`
          SELECT TOP 1
            code,
            discount_type,
            discount_value,
            min_order,
            max_discount,
            expiry,
            active
          FROM coupons
          WHERE code = @code
        `);

      if (couponResult.recordset.length > 0) {
        const coupon = couponResult.recordset[0];

        const now = new Date();

        if (
          coupon.active === true &&
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

    await transaction
      .request()
      .input(
        "id",
        sql.UniqueIdentifier,
        orderId
      )
      .input(
        "userId",
        sql.UniqueIdentifier,
        userId
      )
      .input(
        "orderNumber",
        sql.NVarChar(100),
        orderNumber
      )
      .input(
        "status",
        sql.NVarChar(50),
        "Confirmed"
      )
      .input(
        "paymentMethod",
        sql.NVarChar(50),
        paymentMethod
      )
      .input(
        "paymentStatus",
        sql.NVarChar(50),
        "pending"
      )
      .input(
        "subtotal",
        sql.Decimal(10, 2),
        subtotal
      )
      .input(
        "shippingAmount",
        sql.Decimal(10, 2),
        shippingAmount
      )
      .input(
        "discountAmount",
        sql.Decimal(10, 2),
        discountAmount
      )
      .input(
        "taxAmount",
        sql.Decimal(10, 2),
        taxAmount
      )
      .input(
        "totalAmount",
        sql.Decimal(10, 2),
        totalAmount
      )
      .input(
        "couponCode",
        sql.NVarChar(100),
        cart.coupon_code || null
      )
      .input(
        "shippingName",
        sql.NVarChar(200),
        shippingAddress.name
      )
      .input(
        "shippingPhone",
        sql.NVarChar(30),
        shippingAddress.phone
      )
      .input(
        "shippingPincode",
        sql.NVarChar(20),
        shippingAddress.pincode
      )
      .input(
        "shippingAddress",
        sql.NVarChar(500),
        shippingAddress.address
      )
      .input(
        "shippingCity",
        sql.NVarChar(100),
        shippingAddress.city
      )
      .input(
        "shippingState",
        sql.NVarChar(100),
        shippingAddress.state
      )
      .query(`
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
          @id,
          @userId,
          @orderNumber,
          @status,
          @paymentMethod,
          @paymentStatus,
          @subtotal,
          @shippingAmount,
          @discountAmount,
          @taxAmount,
          @totalAmount,
          @couponCode,
          @shippingName,
          @shippingPhone,
          @shippingPincode,
          @shippingAddress,
          @shippingCity,
          @shippingState,
          SYSUTCDATETIME(),
          SYSUTCDATETIME()
        )
      `);


    // --------------------------------------
    // 10. CREATE ORDER ITEMS
    // --------------------------------------

    for (const item of cartItems) {
      const orderItemId = crypto.randomUUID();

      await transaction
        .request()
        .input(
          "id",
          sql.UniqueIdentifier,
          orderItemId
        )
        .input(
          "orderId",
          sql.UniqueIdentifier,
          orderId
        )
        .input(
          "productId",
          sql.NVarChar(100),
          item.product_id
        )
        .input(
          "variantId",
          sql.UniqueIdentifier,
          item.variant_id
        )
        .input(
          "productName",
          sql.NVarChar(200),
          item.product_name
        )
        .input(
          "productImage",
          sql.NVarChar(2048),
          item.product_image || null
        )
        .input(
          "size",
          sql.NVarChar(10),
          item.size
        )
        .input(
          "color",
          sql.NVarChar(30),
          item.color
        )
        .input(
          "quantity",
          sql.Int,
          item.quantity
        )
        .input(
          "unitPrice",
          sql.Decimal(10, 2),
          Number(item.price_snapshot)
        )
        .input(
          "unitMrp",
          sql.Decimal(10, 2),
          Number(item.product_mrp)
        )
        .query(`
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
            @id,
            @orderId,
            @productId,
            @variantId,
            @productName,
            @productImage,
            @size,
            @color,
            @quantity,
            @unitPrice,
            @unitMrp,
            SYSUTCDATETIME()
          )
        `);
    }


    // --------------------------------------
    // 11. REDUCE INVENTORY
    // --------------------------------------

    for (const item of cartItems) {
      const inventoryResult = await transaction
        .request()
        .input(
          "variantId",
          sql.UniqueIdentifier,
          item.variant_id
        )
        .input(
          "quantity",
          sql.Int,
          item.quantity
        )
        .query(`
          UPDATE product_variants
          SET
            inventory = inventory - @quantity,
            updated_at = SYSUTCDATETIME()
          WHERE id = @variantId
            AND inventory >= @quantity
        `);

      if (inventoryResult.rowsAffected[0] === 0) {
        throw new Error(
          `Unable to update inventory for ${item.product_name}.`
        );
      }
    }


    // --------------------------------------
    // 12. CLEAR CART
    // --------------------------------------

    await transaction
      .request()
      .input(
        "cartId",
        sql.UniqueIdentifier,
        cart.id
      )
      .query(`
        DELETE FROM cart_items
        WHERE cart_id = @cartId
      `);

    await transaction
      .request()
      .input(
        "cartId",
        sql.UniqueIdentifier,
        cart.id
      )
      .query(`
        UPDATE carts
        SET
          coupon_code = NULL,
          updated_at = SYSUTCDATETIME()
        WHERE id = @cartId
      `);


    // --------------------------------------
    // COMMIT
    // --------------------------------------

    await transaction.commit();


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
      await transaction.rollback();
    } catch (_) {}

    throw error;
  }
};


// ==========================================
// GET MY ORDERS
// ==========================================

const getMyOrders = async (userId) => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input(
      "userId",
      sql.UniqueIdentifier,
      userId
    )
    .query(`
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
      WHERE user_id = @userId
      ORDER BY created_at DESC
    `);

  return result.recordset;
};


// ==========================================
// GET ORDER BY ID
// ==========================================

const getOrderById = async (userId, orderId) => {
  const pool = await poolPromise;

  const orderResult = await pool
    .request()
    .input(
      "userId",
      sql.UniqueIdentifier,
      userId
    )
    .input(
      "orderId",
      sql.UniqueIdentifier,
      orderId
    )
    .query(`
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
      WHERE id = @orderId
        AND user_id = @userId
    `);

  if (orderResult.recordset.length === 0) {
    throw new Error("Order not found.");
  }

  const itemsResult = await pool
    .request()
    .input(
      "orderId",
      sql.UniqueIdentifier,
      orderId
    )
    .query(`
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
      WHERE order_id = @orderId
      ORDER BY created_at ASC
    `);

  return {
    ...orderResult.recordset[0],
    items: itemsResult.recordset,
  };
};


// ==========================================
// CANCEL ORDER
// ==========================================

const cancelOrder = async (userId, orderId) => {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const orderResult = await transaction
      .request()
      .input(
        "userId",
        sql.UniqueIdentifier,
        userId
      )
      .input(
        "orderId",
        sql.UniqueIdentifier,
        orderId
      )
      .query(`
        SELECT
          id,
          status
        FROM orders
        WHERE id = @orderId
          AND user_id = @userId
      `);

    if (orderResult.recordset.length === 0) {
      throw new Error("Order not found.");
    }

    const order = orderResult.recordset[0];


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


    const itemsResult = await transaction
      .request()
      .input(
        "orderId",
        sql.UniqueIdentifier,
        orderId
      )
      .query(`
        SELECT
          variant_id,
          quantity
        FROM order_items
        WHERE order_id = @orderId
      `);


    // Restore inventory

    for (const item of itemsResult.recordset) {
      await transaction
        .request()
        .input(
          "variantId",
          sql.UniqueIdentifier,
          item.variant_id
        )
        .input(
          "quantity",
          sql.Int,
          item.quantity
        )
        .query(`
          UPDATE product_variants
          SET
            inventory = inventory + @quantity,
            updated_at = SYSUTCDATETIME()
          WHERE id = @variantId
        `);
    }


    // Update order

    await transaction
      .request()
      .input(
        "orderId",
        sql.UniqueIdentifier,
        orderId
      )
      .query(`
        UPDATE orders
        SET
          status = 'Cancelled',
          updated_at = SYSUTCDATETIME()
        WHERE id = @orderId
      `);


    await transaction.commit();


    return {
      id: orderId,
      status: "Cancelled",
    };

  } catch (error) {
    try {
      await transaction.rollback();
    } catch (_) {}

    throw error;
  }
};


// ==========================================
// GET ALL ORDERS - ADMIN
// ==========================================

const getAllOrders = async () => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .query(`
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
    `);

  return result.recordset;
};


// ==========================================
// UPDATE ORDER STATUS - ADMIN
// ==========================================

const updateOrderStatus = async (orderId, status) => {

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

  const result = await pool
    .request()
    .input(
      "orderId",
      sql.UniqueIdentifier,
      orderId
    )
    .input(
      "status",
      sql.NVarChar(50),
      status
    )
    .query(`
      UPDATE orders
      SET
        status = @status,
        updated_at = SYSUTCDATETIME()
      WHERE id = @orderId;

      SELECT
        id,
        order_number,
        status,
        payment_status,
        total_amount,
        updated_at
      FROM orders
      WHERE id = @orderId;
    `);


  if (result.recordset.length === 0) {
    throw new Error("Order not found.");
  }


  return result.recordset[0];
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