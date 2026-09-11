const { sql, poolPromise } = require("../config/sql");

// ==========================================
// GET USER WISHLIST
// ==========================================

const getWishlist = async (userId) => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      SELECT
        w.id,
        w.product_id,
        p.slug,
        p.name,
        p.category_slug,
        p.category_label,
        p.fit,
        p.fabric,
        p.coverage,
        p.price,
        p.mrp,
        p.best_price,
        p.rating,
        p.review_count,
        p.best_seller,
        p.new_arrival,
        p.trending,
        p.limited_edition,
        p.inventory,

        (
          SELECT TOP 1
            pi.image_url
          FROM product_images pi
          WHERE pi.product_id = p.id
            AND pi.is_primary = 1
          ORDER BY pi.sort_order ASC
        ) AS primary_image,

        w.created_at

      FROM wishlist_items w
      INNER JOIN products p
        ON w.product_id = p.id

      WHERE w.user_id = @userId

      ORDER BY w.created_at DESC
    `);

  return result.recordset;
};

// ==========================================
// ADD TO WISHLIST
// ==========================================

const addToWishlist = async ({
  userId,
  productId,
}) => {
  const pool = await poolPromise;

  // Check product exists
  const productResult = await pool
    .request()
    .input("productId", sql.NVarChar(100), productId)
    .query(`
      SELECT TOP 1
        id,
        name,
        inventory
      FROM products
      WHERE id = @productId
    `);

  if (productResult.recordset.length === 0) {
    throw new Error("Product not found.");
  }

  // Check already exists
  const existingResult = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("productId", sql.NVarChar(100), productId)
    .query(`
      SELECT TOP 1 id
      FROM wishlist_items
      WHERE
        user_id = @userId
        AND product_id = @productId
    `);

  if (existingResult.recordset.length > 0) {
    throw new Error(
      "Product is already in your wishlist."
    );
  }

  // Add wishlist item
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("productId", sql.NVarChar(100), productId)
    .query(`
      INSERT INTO wishlist_items
      (
        id,
        user_id,
        product_id,
        created_at
      )
      OUTPUT
        INSERTED.id,
        INSERTED.user_id,
        INSERTED.product_id,
        INSERTED.created_at
      VALUES
      (
        NEWID(),
        @userId,
        @productId,
        SYSUTCDATETIME()
      )
    `);

  return result.recordset[0];
};

// ==========================================
// REMOVE FROM WISHLIST
// ==========================================

const removeFromWishlist = async ({
  userId,
  productId,
}) => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("productId", sql.NVarChar(100), productId)
    .query(`
      DELETE FROM wishlist_items
      OUTPUT
        DELETED.id,
        DELETED.user_id,
        DELETED.product_id
      WHERE
        user_id = @userId
        AND product_id = @productId
    `);

  if (result.recordset.length === 0) {
    throw new Error(
      "Product is not in your wishlist."
    );
  }

  return result.recordset[0];
};

// ==========================================
// CHECK WISHLIST
// ==========================================

const isInWishlist = async ({
  userId,
  productId,
}) => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("productId", sql.NVarChar(100), productId)
    .query(`
      SELECT TOP 1 id
      FROM wishlist_items
      WHERE
        user_id = @userId
        AND product_id = @productId
    `);

  return result.recordset.length > 0;
};

// ==========================================
// CLEAR WISHLIST
// ==========================================

const clearWishlist = async (userId) => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      DELETE FROM wishlist_items
      WHERE user_id = @userId
    `);

  return {
    deletedCount: result.rowsAffected[0],
  };
};

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  getWishlist,
  addToWishlist,
  removeFromWishlist,
  isInWishlist,
  clearWishlist,
};