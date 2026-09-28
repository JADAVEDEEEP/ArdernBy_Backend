const { randomUUID } = require("crypto");
const { poolPromise } = require("../config/sql");
const couponService = require("./coupon.service");

// GET USER CART
const getCart = async (userId) => {
  const pool = await poolPromise;

  const [cartRows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        coupon_code,
        created_at,
        updated_at
      FROM carts
      WHERE user_id = ?
      LIMIT 1
    `,
    [userId]
  );

  if (cartRows.length === 0) {
    return {
      cart: null,
      items: [],
    };
  }

  const cart = cartRows[0];

  const [itemRows] = await pool.execute(
    `
      SELECT
        id,
        cart_id,
        product_id,
        variant_id,
        product_name_snapshot,
        image_snapshot,
        size,
        color,
        quantity,
        price_snapshot,
        mrp_snapshot,
        created_at,
        updated_at
      FROM cart_items
      WHERE cart_id = ?
      ORDER BY created_at ASC
    `,
    [cart.id]
  );

  return {
    cart,
    items: itemRows,
  };
};

// CREATE CART
const createCart = async (userId) => {
  const pool = await poolPromise;

  const [existingRows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        coupon_code,
        created_at,
        updated_at
      FROM carts
      WHERE user_id = ?
      LIMIT 1
    `,
    [userId]
  );

  if (existingRows.length > 0) {
    return existingRows[0];
  }

  const id = randomUUID();

  await pool.execute(
    `
      INSERT INTO carts
      (
        id,
        user_id,
        coupon_code,
        created_at,
        updated_at
      )
      VALUES
      (
        ?,
        ?,
        NULL,
        UTC_TIMESTAMP(6),
        UTC_TIMESTAMP(6)
      )
    `,
    [id, userId]
  );

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        coupon_code,
        created_at,
        updated_at
      FROM carts
      WHERE id = ?
      LIMIT 1
    `,
    [id]
  );

  return rows[0];
};

// ADD ITEM TO CART
const addCartItem = async (userId, item) => {
  const {
    product_id,
    variant_id,
    quantity,
  } = item;

  if (!product_id || !variant_id || !quantity) {
    throw new Error(
      "product_id, variant_id and quantity are required."
    );
  }

  if (quantity <= 0) {
    throw new Error("Quantity must be greater than 0.");
  }

  const pool = await poolPromise;

  // Find user's cart
  const [cartRows] = await pool.execute(
    `
      SELECT id
      FROM carts
      WHERE user_id = ?
      LIMIT 1
    `,
    [userId]
  );

  let cartId;

  if (cartRows.length === 0) {
    const newCart = await createCart(userId);
    cartId = newCart.id;
  } else {
    cartId = cartRows[0].id;
  }

  // Get product
  const [productRows] = await pool.execute(
    `
      SELECT
        id,
        name,
        price,
        mrp
      FROM products
      WHERE id = ?
      LIMIT 1
    `,
    [product_id]
  );

  if (productRows.length === 0) {
    throw new Error("Product not found.");
  }

  const product = productRows[0];

  // Get variant
  const [variantRows] = await pool.execute(
    `
      SELECT
        id,
        product_id,
        size,
        color,
        inventory,
        sku
      FROM product_variants
      WHERE id = ?
        AND product_id = ?
      LIMIT 1
    `,
    [variant_id, product_id]
  );

  if (variantRows.length === 0) {
    throw new Error("Product variant not found.");
  }

  const variant = variantRows[0];

  // Check inventory
  if (variant.inventory < quantity) {
    throw new Error("Insufficient variant inventory.");
  }

  // Check existing cart item
  const [existingItemRows] = await pool.execute(
    `
      SELECT
        id,
        quantity
      FROM cart_items
      WHERE cart_id = ?
        AND product_id = ?
        AND variant_id = ?
      LIMIT 1
    `,
    [cartId, product_id, variant_id]
  );

  // If item already exists, increase quantity
  if (existingItemRows.length > 0) {
    const existing = existingItemRows[0];

    const newQuantity = existing.quantity + quantity;

    if (variant.inventory < newQuantity) {
      throw new Error("Insufficient variant inventory.");
    }

    await pool.execute(
      `
        UPDATE cart_items
        SET
          quantity = ?,
          updated_at = UTC_TIMESTAMP(6)
        WHERE id = ?
      `,
      [newQuantity, existing.id]
    );

    return getCart(userId);
  }

  // Get primary image
  const [imageRows] = await pool.execute(
    `
      SELECT image_url
      FROM product_images
      WHERE product_id = ?
      ORDER BY
        is_primary DESC,
        sort_order ASC
      LIMIT 1
    `,
    [product_id]
  );

  const imageSnapshot =
    imageRows.length > 0
      ? imageRows[0].image_url
      : null;

  // Insert cart item
  const cartItemId = randomUUID();

  await pool.execute(
    `
      INSERT INTO cart_items
      (
        id,
        cart_id,
        product_id,
        variant_id,
        product_name_snapshot,
        image_snapshot,
        size,
        color,
        quantity,
        price_snapshot,
        mrp_snapshot,
        created_at,
        updated_at
      )
      VALUES
      (
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
      cartItemId,
      cartId,
      product_id,
      variant_id,
      product.name,
      imageSnapshot,
      variant.size,
      variant.color,
      quantity,
      product.price,
      product.mrp,
    ]
  );

  return getCart(userId);
};

// UPDATE CART ITEM
const updateCartItem = async (userId, itemId, quantity) => {
  if (!quantity || quantity <= 0) {
    throw new Error("Quantity must be greater than 0.");
  }

  const pool = await poolPromise;

  const [itemRows] = await pool.execute(
    `
      SELECT
        ci.id,
        ci.variant_id,
        ci.product_id
      FROM cart_items ci
      INNER JOIN carts c
        ON ci.cart_id = c.id
      WHERE ci.id = ?
        AND c.user_id = ?
      LIMIT 1
    `,
    [itemId, userId]
  );

  if (itemRows.length === 0) {
    throw new Error("Cart item not found.");
  }

  const item = itemRows[0];

  // Check variant inventory
  const [variantRows] = await pool.execute(
    `
      SELECT inventory
      FROM product_variants
      WHERE id = ?
      LIMIT 1
    `,
    [item.variant_id]
  );

  if (variantRows.length === 0) {
    throw new Error("Product variant not found.");
  }

  if (variantRows[0].inventory < quantity) {
    throw new Error("Insufficient variant inventory.");
  }

  await pool.execute(
    `
      UPDATE cart_items
      SET
        quantity = ?,
        updated_at = UTC_TIMESTAMP(6)
      WHERE id = ?
    `,
    [quantity, itemId]
  );

  return getCart(userId);
};

// REMOVE CART ITEM
const removeCartItem = async (userId, itemId) => {
  const pool = await poolPromise;

  // First verify item belongs to user's cart
  const [itemRows] = await pool.execute(
    `
      SELECT ci.id
      FROM cart_items ci
      INNER JOIN carts c
        ON ci.cart_id = c.id
      WHERE ci.id = ?
        AND c.user_id = ?
      LIMIT 1
    `,
    [itemId, userId]
  );

  if (itemRows.length === 0) {
    throw new Error("Cart item not found.");
  }

  await pool.execute(
    `
      DELETE FROM cart_items
      WHERE id = ?
    `,
    [itemId]
  );

  return getCart(userId);
};

// CLEAR CART
const clearCart = async (userId) => {
  const pool = await poolPromise;

  const [cartRows] = await pool.execute(
    `
      SELECT id
      FROM carts
      WHERE user_id = ?
      LIMIT 1
    `,
    [userId]
  );

  if (cartRows.length === 0) {
    return {
      cart: null,
      items: [],
    };
  }

  const cartId = cartRows[0].id;

  await pool.execute(
    `
      DELETE FROM cart_items
      WHERE cart_id = ?
    `,
    [cartId]
  );

  return getCart(userId);
};

// UPDATE CART COUPON
const updateCartCoupon = async (userId, couponCode) => {
  const pool = await poolPromise;

  // Find customer's cart
  const [cartRows] = await pool.execute(
    `
      SELECT id
      FROM carts
      WHERE user_id = ?
      LIMIT 1
    `,
    [userId]
  );

  if (cartRows.length === 0) {
    throw new Error("Cart not found.");
  }

  const cartId = cartRows[0].id;

  // Remove coupon
  if (!couponCode) {
    await pool.execute(
      `
        UPDATE carts
        SET
          coupon_code = NULL,
          updated_at = UTC_TIMESTAMP(6)
        WHERE id = ?
      `,
      [cartId]
    );

    return getCart(userId);
  }

  // Get cart items for subtotal
  const [itemRows] = await pool.execute(
    `
      SELECT
        quantity,
        price_snapshot
      FROM cart_items
      WHERE cart_id = ?
    `,
    [cartId]
  );

  if (itemRows.length === 0) {
    throw new Error("Cart is empty.");
  }

  // Calculate subtotal
  const subtotal = itemRows.reduce(
    (total, item) =>
      total +
      Number(item.price_snapshot) * Number(item.quantity),
    0
  );

  // Validate coupon + calculate discount
  const couponResult = await couponService.validateCoupon(
    couponCode,
    subtotal
  );

  const normalizedCouponCode =
    couponCode.trim().toUpperCase();

  // Save valid coupon
  await pool.execute(
    `
      UPDATE carts
      SET
        coupon_code = ?,
        updated_at = UTC_TIMESTAMP(6)
      WHERE id = ?
    `,
    [normalizedCouponCode, cartId]
  );

  const cart = await getCart(userId);

  return {
    ...cart,
    subtotal: couponResult.subtotal,
    discount: couponResult.discount,
    total: couponResult.total,
  };
};

module.exports = {
  getCart,
  createCart,
  addCartItem,
  updateCartItem,
  removeCartItem,
  clearCart,
  updateCartCoupon,
};