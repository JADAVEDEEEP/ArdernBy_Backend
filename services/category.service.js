const { poolPromise } = require("../config/sql");

// ==========================================
// GET ALL CATEGORIES
// ==========================================

const getAllCategories = async () => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        slug,
        name,
        description,
        created_at
      FROM categories
      ORDER BY created_at DESC
    `
  );

  return rows;
};

// ==========================================
// GET SINGLE CATEGORY BY SLUG
// ==========================================

const getCategoryBySlug = async (slug) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        slug,
        name,
        description,
        created_at
      FROM categories
      WHERE slug = ?
      LIMIT 1
    `,
    [slug]
  );

  if (rows.length === 0) {
    throw new Error("Category not found.");
  }

  return rows[0];
};

// ==========================================
// CREATE CATEGORY
// ==========================================

const createCategory = async (category) => {
  const {
    slug,
    name,
    description,
  } = category;

  if (!slug || !name) {
    throw new Error("slug and name are required.");
  }

  const pool = await poolPromise;

  // ==========================================
  // CHECK DUPLICATE SLUG
  // ==========================================

  const [existingRows] = await pool.execute(
    `
      SELECT slug
      FROM categories
      WHERE slug = ?
      LIMIT 1
    `,
    [slug]
  );

  if (existingRows.length > 0) {
    throw new Error(
      "Category with this slug already exists."
    );
  }

  // ==========================================
  // CREATE CATEGORY
  // ==========================================

  await pool.execute(
    `
      INSERT INTO categories
      (
        slug,
        name,
        description,
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
      slug,
      name,
      description || null,
    ]
  );

  return getCategoryBySlug(slug);
};

// ==========================================
// UPDATE CATEGORY
// ==========================================

const updateCategory = async (slug, category) => {
  const {
    name,
    description,
  } = category;

  if (!name) {
    throw new Error("name is required.");
  }

  const pool = await poolPromise;

  // ==========================================
  // CHECK CATEGORY EXISTS
  // ==========================================

  const [existingRows] = await pool.execute(
    `
      SELECT slug
      FROM categories
      WHERE slug = ?
      LIMIT 1
    `,
    [slug]
  );

  if (existingRows.length === 0) {
    throw new Error("Category not found.");
  }

  // ==========================================
  // UPDATE CATEGORY
  // ==========================================

  await pool.execute(
    `
      UPDATE categories
      SET
        name = ?,
        description = ?
      WHERE slug = ?
    `,
    [
      name,
      description || null,
      slug,
    ]
  );

  return getCategoryBySlug(slug);
};

// ==========================================
// DELETE CATEGORY
// ==========================================

const deleteCategory = async (slug) => {
  const pool = await poolPromise;

  // ==========================================
  // CHECK CATEGORY EXISTS
  // ==========================================

  const [existingRows] = await pool.execute(
    `
      SELECT slug
      FROM categories
      WHERE slug = ?
      LIMIT 1
    `,
    [slug]
  );

  if (existingRows.length === 0) {
    throw new Error("Category not found.");
  }

  // ==========================================
  // CHECK IF PRODUCTS ARE USING THIS CATEGORY
  // ==========================================

  const [productRows] = await pool.execute(
    `
      SELECT COUNT(*) AS product_count
      FROM products
      WHERE category_slug = ?
    `,
    [slug]
  );

  if (Number(productRows[0].product_count) > 0) {
    throw new Error(
      "Cannot delete category because products are using this category."
    );
  }

  // ==========================================
  // DELETE CATEGORY
  // ==========================================

  await pool.execute(
    `
      DELETE FROM categories
      WHERE slug = ?
    `,
    [slug]
  );

  return true;
};

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  getAllCategories,
  getCategoryBySlug,
  createCategory,
  updateCategory,
  deleteCategory,
};