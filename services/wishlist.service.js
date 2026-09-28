const { poolPromise } = require("../config/sql");

// ==========================================
// GET USER WISHLIST
// ==========================================

const getWishlist = async (userId) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
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
          SELECT pi.image_url
          FROM product_images pi
          WHERE pi.product_id = p.id
            AND pi.is_primary = 1
          ORDER BY pi.sort_order ASC
          LIMIT 1
        ) AS primary_image,

        w.created_at

      FROM wishlist_items w

      INNER JOIN products p
        ON w.product_id = p.id

      WHERE w.user_id = ?

      ORDER BY w.created_at DESC
    `,
    [userId]
  );

  return rows;
};

// ==========================================
// ADD TO WISHLIST
// ==========================================

const addToWishlist = async ({
  userId,
  productId,
}) => {
  const pool = await poolPromise;

  // ==========================================
  // CHECK PRODUCT EXISTS
  // ==========================================

  const [productRows] = await pool.execute(
    `
      SELECT
        id,
        name,
        inventory
      FROM products
      WHERE id = ?
      LIMIT 1
    `,
    [productId]
  );

  if (productRows.length === 0) {
    throw new Error("Product not found.");
  }

  // ==========================================
  // CHECK ALREADY EXISTS
  // ==========================================

  const [existingRows] = await pool.execute(
    `
      SELECT id
      FROM wishlist_items
      WHERE
        user_id = ?
        AND product_id = ?
      LIMIT 1
    `,
    [userId, productId]
  );

  if (existingRows.length > 0) {
    throw new Error(
      "Product is already in your wishlist."
    );
  }

  // ==========================================
  // ADD WISHLIST ITEM
  // ==========================================

  const wishlistId = require("crypto").randomUUID();

  await pool.execute(
    `
      INSERT INTO wishlist_items
      (
        id,
        user_id,
        product_id,
        created_at
      )
      VALUES
      (
        ?,
        ?,
        ?,
        UTC_TIMESTAMP(6)
      )
    `,
    [
      wishlistId,
      userId,
      productId,
    ]
  );

  // MySQL does not support SQL Server's
  // OUTPUT INSERTED, so fetch the inserted row.

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        product_id,
        created_at
      FROM wishlist_items
      WHERE id = ?
      LIMIT 1
    `,
    [wishlistId]
  );

  return rows[0];
};

// ==========================================
// REMOVE FROM WISHLIST
// ==========================================

const removeFromWishlist = async ({
  userId,
  productId,
}) => {
  const pool = await poolPromise;

  // MySQL does not support SQL Server's
  // DELETE ... OUTPUT DELETED syntax.
  // First find the item, then delete it.

  const [existingRows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        product_id
      FROM wishlist_items
      WHERE
        user_id = ?
        AND product_id = ?
      LIMIT 1
    `,
    [
      userId,
      productId,
    ]
  );

  if (existingRows.length === 0) {
    throw new Error(
      "Product is not in your wishlist."
    );
  }

  const wishlistItem = existingRows[0];

  await pool.execute(
    `
      DELETE FROM wishlist_items
      WHERE
        user_id = ?
        AND product_id = ?
    `,
    [
      userId,
      productId,
    ]
  );

  return wishlistItem;
};

// ==========================================
// CHECK WISHLIST
// ==========================================

const isInWishlist = async ({
  userId,
  productId,
}) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT id
      FROM wishlist_items
      WHERE
        user_id = ?
        AND product_id = ?
      LIMIT 1
    `,
    [
      userId,
      productId,
    ]
  );

  return rows.length > 0;
};

// ==========================================
// CLEAR WISHLIST
// ==========================================

const clearWishlist = async (userId) => {
  const pool = await poolPromise;

  const [result] = await pool.execute(
    `
      DELETE FROM wishlist_items
      WHERE user_id = ?
    `,
    [userId]
  );

  return {
    deletedCount: result.affectedRows,
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