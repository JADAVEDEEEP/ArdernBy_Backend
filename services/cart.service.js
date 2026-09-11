const { sql, poolPromise } = require("../config/sql");
const couponService = require("./coupon.service");

// GET USER CART
const getCart = async (userId) => {
  const pool = await poolPromise;

  const cartResult = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      SELECT
        id,
        user_id,
        coupon_code,
        created_at,
        updated_at
      FROM dbo.carts
      WHERE user_id = @userId
    `);

  if (cartResult.recordset.length === 0) {
    return {
      cart: null,
      items: [],
    };
  }

  const cart = cartResult.recordset[0];

  const itemsResult = await pool
    .request()
    .input("cartId", sql.UniqueIdentifier, cart.id)
    .query(`
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
      FROM dbo.cart_items
      WHERE cart_id = @cartId
      ORDER BY created_at ASC
    `);

  return {
    cart,
    items: itemsResult.recordset,
  };
};

// CREATE CART
const createCart = async (userId) => {
  const pool = await poolPromise;

  const existing = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      SELECT
        id,
        user_id,
        coupon_code,
        created_at,
        updated_at
      FROM dbo.carts
      WHERE user_id = @userId
    `);

  if (existing.recordset.length > 0) {
    return existing.recordset[0];
  }

  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      INSERT INTO dbo.carts
      (
        id,
        user_id,
        coupon_code,
        created_at,
        updated_at
      )
      OUTPUT
        INSERTED.id,
        INSERTED.user_id,
        INSERTED.coupon_code,
        INSERTED.created_at,
        INSERTED.updated_at
      VALUES
      (
        NEWID(),
        @userId,
        NULL,
        SYSUTCDATETIME(),
        SYSUTCDATETIME()
      )
    `);

  return result.recordset[0];
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
  let cartResult = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      SELECT id
      FROM dbo.carts
      WHERE user_id = @userId
    `);

  let cartId;

  if (cartResult.recordset.length === 0) {
    const newCart = await createCart(userId);
    cartId = newCart.id;
  } else {
    cartId = cartResult.recordset[0].id;
  }

  // Get product
  const productResult = await pool
    .request()
    .input("productId", sql.NVarChar(100), product_id)
    .query(`
      SELECT
        id,
        name,
        price,
        mrp
      FROM dbo.products
      WHERE id = @productId
    `);

  if (productResult.recordset.length === 0) {
    throw new Error("Product not found.");
  }

  const product = productResult.recordset[0];

  // Get variant
  const variantResult = await pool
    .request()
    .input("variantId", sql.UniqueIdentifier, variant_id)
    .input("productId", sql.NVarChar(100), product_id)
    .query(`
      SELECT
        id,
        product_id,
        size,
        color,
        inventory,
        sku
      FROM dbo.product_variants
      WHERE id = @variantId
        AND product_id = @productId
    `);

  if (variantResult.recordset.length === 0) {
    throw new Error("Product variant not found.");
  }

  const variant = variantResult.recordset[0];

  // Check inventory
  if (variant.inventory < quantity) {
    throw new Error("Insufficient variant inventory.");
  }

  // Check existing cart item
  const existingItem = await pool
    .request()
    .input("cartId", sql.UniqueIdentifier, cartId)
    .input("productId", sql.NVarChar(100), product_id)
    .input("variantId", sql.UniqueIdentifier, variant_id)
    .query(`
      SELECT
        id,
        quantity
      FROM dbo.cart_items
      WHERE cart_id = @cartId
        AND product_id = @productId
        AND variant_id = @variantId
    `);

  // If item already exists, increase quantity
  if (existingItem.recordset.length > 0) {
    const existing = existingItem.recordset[0];

    const newQuantity = existing.quantity + quantity;

    if (variant.inventory < newQuantity) {
      throw new Error("Insufficient variant inventory.");
    }

    await pool
      .request()
      .input("itemId", sql.UniqueIdentifier, existing.id)
      .input("quantity", sql.Int, newQuantity)
      .query(`
        UPDATE dbo.cart_items
        SET
          quantity = @quantity,
          updated_at = SYSUTCDATETIME()
        WHERE id = @itemId
      `);

    return getCart(userId);
  }

  // Get primary image
  const imageResult = await pool
    .request()
    .input("productId", sql.NVarChar(100), product_id)
    .query(`
      SELECT TOP 1
        image_url
      FROM dbo.product_images
      WHERE product_id = @productId
      ORDER BY
        is_primary DESC,
        sort_order ASC
    `);

  const imageSnapshot =
    imageResult.recordset.length > 0
      ? imageResult.recordset[0].image_url
      : null;

  // Insert cart item
  await pool
    .request()
    .input("cartId", sql.UniqueIdentifier, cartId)
    .input("productId", sql.NVarChar(100), product_id)
    .input("variantId", sql.UniqueIdentifier, variant_id)
    .input(
      "productNameSnapshot",
      sql.NVarChar(200),
      product.name
    )
    .input(
      "imageSnapshot",
      sql.NVarChar(2048),
      imageSnapshot
    )
    .input("size", sql.NVarChar(10), variant.size)
    .input("color", sql.NVarChar(30), variant.color)
    .input("quantity", sql.Int, quantity)
    .input(
      "priceSnapshot",
      sql.Decimal(18, 2),
      product.price
    )
    .input(
      "mrpSnapshot",
      sql.Decimal(18, 2),
      product.mrp
    )
    .query(`
      INSERT INTO dbo.cart_items
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
        NEWID(),
        @cartId,
        @productId,
        @variantId,
        @productNameSnapshot,
        @imageSnapshot,
        @size,
        @color,
        @quantity,
        @priceSnapshot,
        @mrpSnapshot,
        SYSUTCDATETIME(),
        SYSUTCDATETIME()
      )
    `);

  return getCart(userId);
};

// UPDATE CART ITEM
const updateCartItem = async (userId, itemId, quantity) => {
  if (!quantity || quantity <= 0) {
    throw new Error("Quantity must be greater than 0.");
  }

  const pool = await poolPromise;

  const itemResult = await pool
    .request()
    .input("itemId", sql.UniqueIdentifier, itemId)
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      SELECT
        ci.id,
        ci.variant_id,
        ci.product_id
      FROM dbo.cart_items ci
      INNER JOIN dbo.carts c
        ON ci.cart_id = c.id
      WHERE ci.id = @itemId
        AND c.user_id = @userId
    `);

  if (itemResult.recordset.length === 0) {
    throw new Error("Cart item not found.");
  }

  const item = itemResult.recordset[0];

  // Check variant inventory
  const variantResult = await pool
    .request()
    .input("variantId", sql.UniqueIdentifier, item.variant_id)
    .query(`
      SELECT inventory
      FROM dbo.product_variants
      WHERE id = @variantId
    `);

  if (variantResult.recordset.length === 0) {
    throw new Error("Product variant not found.");
  }

  if (variantResult.recordset[0].inventory < quantity) {
    throw new Error("Insufficient variant inventory.");
  }

  await pool
    .request()
    .input("itemId", sql.UniqueIdentifier, itemId)
    .input("quantity", sql.Int, quantity)
    .query(`
      UPDATE dbo.cart_items
      SET
        quantity = @quantity,
        updated_at = SYSUTCDATETIME()
      WHERE id = @itemId
    `);

  return getCart(userId);
};

// REMOVE CART ITEM
const removeCartItem = async (userId, itemId) => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input("itemId", sql.UniqueIdentifier, itemId)
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      DELETE ci
      FROM dbo.cart_items ci
      INNER JOIN dbo.carts c
        ON ci.cart_id = c.id
      WHERE ci.id = @itemId
        AND c.user_id = @userId
    `);

  if (result.rowsAffected[0] === 0) {
    throw new Error("Cart item not found.");
  }

  return getCart(userId);
};

// CLEAR CART
const clearCart = async (userId) => {
  const pool = await poolPromise;

  const cartResult = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      SELECT id
      FROM dbo.carts
      WHERE user_id = @userId
    `);

  if (cartResult.recordset.length === 0) {
    return {
      cart: null,
      items: [],
    };
  }

  const cartId = cartResult.recordset[0].id;

  await pool
    .request()
    .input("cartId", sql.UniqueIdentifier, cartId)
    .query(`
      DELETE FROM dbo.cart_items
      WHERE cart_id = @cartId
    `);

  return getCart(userId);
};

// UPDATE CART COUPON
const updateCartCoupon = async (userId, couponCode) => {
  const pool = await poolPromise;

  // Find customer's cart
  const cartResult = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      SELECT id
      FROM dbo.carts
      WHERE user_id = @userId
    `);

  if (cartResult.recordset.length === 0) {
    throw new Error("Cart not found.");
  }

  const cartId = cartResult.recordset[0].id;

  // Remove coupon
  if (!couponCode) {
    await pool
      .request()
      .input("cartId", sql.UniqueIdentifier, cartId)
      .query(`
        UPDATE dbo.carts
        SET
          coupon_code = NULL,
          updated_at = SYSUTCDATETIME()
        WHERE id = @cartId
      `);

    return getCart(userId);
  }

  // Get cart items for subtotal
  const itemsResult = await pool
    .request()
    .input("cartId", sql.UniqueIdentifier, cartId)
    .query(`
      SELECT
        quantity,
        price_snapshot
      FROM dbo.cart_items
      WHERE cart_id = @cartId
    `);

  if (itemsResult.recordset.length === 0) {
    throw new Error("Cart is empty.");
  }

  // Calculate subtotal
  const subtotal = itemsResult.recordset.reduce(
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

  // Save valid coupon
  await pool
    .request()
    .input("cartId", sql.UniqueIdentifier, cartId)
    .input(
      "couponCode",
      sql.NVarChar(100),
      couponCode.trim().toUpperCase()
    )
    .query(`
      UPDATE dbo.carts
      SET
        coupon_code = @couponCode,
        updated_at = SYSUTCDATETIME()
      WHERE id = @cartId
    `);

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