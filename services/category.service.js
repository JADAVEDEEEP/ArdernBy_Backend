const { sql, poolPromise } = require("../config/sql");

// GET ALL CATEGORIES
const getAllCategories = async () => {
  const pool = await poolPromise;

  const result = await pool.request().query(`
    SELECT
      slug,
      name,
      description,
      created_at
    FROM dbo.categories
    ORDER BY created_at DESC
  `);

  return result.recordset;
};

// GET SINGLE CATEGORY BY SLUG
const getCategoryBySlug = async (slug) => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input("slug", sql.NVarChar(100), slug)
    .query(`
      SELECT
        slug,
        name,
        description,
        created_at
      FROM dbo.categories
      WHERE slug = @slug
    `);

  if (result.recordset.length === 0) {
    throw new Error("Category not found.");
  }

  return result.recordset[0];
};

// CREATE CATEGORY
const createCategory = async (category) => {
  const { slug, name, description } = category;

  if (!slug || !name) {
    throw new Error("slug and name are required.");
  }

  const pool = await poolPromise;

  // Check duplicate slug
  const existing = await pool
    .request()
    .input("slug", sql.NVarChar(100), slug)
    .query(`
      SELECT slug
      FROM dbo.categories
      WHERE slug = @slug
    `);

  if (existing.recordset.length > 0) {
    throw new Error("Category with this slug already exists.");
  }

  await pool
    .request()
    .input("slug", sql.NVarChar(100), slug)
    .input("name", sql.NVarChar(150), name)
    .input("description", sql.NVarChar(sql.MAX), description || null)
    .query(`
      INSERT INTO dbo.categories
      (
        slug,
        name,
        description,
        created_at
      )
      VALUES
      (
        @slug,
        @name,
        @description,
        SYSUTCDATETIME()
      )
    `);

  return getCategoryBySlug(slug);
};

// UPDATE CATEGORY
const updateCategory = async (slug, category) => {
  const { name, description } = category;

  if (!name) {
    throw new Error("name is required.");
  }

  const pool = await poolPromise;

  // Check category exists
  const existing = await pool
    .request()
    .input("slug", sql.NVarChar(100), slug)
    .query(`
      SELECT slug
      FROM dbo.categories
      WHERE slug = @slug
    `);

  if (existing.recordset.length === 0) {
    throw new Error("Category not found.");
  }

  await pool
    .request()
    .input("slug", sql.NVarChar(100), slug)
    .input("name", sql.NVarChar(150), name)
    .input("description", sql.NVarChar(sql.MAX), description || null)
    .query(`
      UPDATE dbo.categories
      SET
        name = @name,
        description = @description
      WHERE slug = @slug
    `);

  return getCategoryBySlug(slug);
};

// DELETE CATEGORY
const deleteCategory = async (slug) => {
  const pool = await poolPromise;

  // Check category exists
  const existing = await pool
    .request()
    .input("slug", sql.NVarChar(100), slug)
    .query(`
      SELECT slug
      FROM dbo.categories
      WHERE slug = @slug
    `);

  if (existing.recordset.length === 0) {
    throw new Error("Category not found.");
  }

  // Check if products are using this category
  const products = await pool
    .request()
    .input("slug", sql.NVarChar(100), slug)
    .query(`
      SELECT COUNT(*) AS product_count
      FROM dbo.products
      WHERE category_slug = @slug
    `);

  if (products.recordset[0].product_count > 0) {
    throw new Error(
      "Cannot delete category because products are using this category."
    );
  }

  await pool
    .request()
    .input("slug", sql.NVarChar(100), slug)
    .query(`
      DELETE FROM dbo.categories
      WHERE slug = @slug
    `);

  return true;
};

module.exports = {
  getAllCategories,
  getCategoryBySlug,
  createCategory,
  updateCategory,
  deleteCategory,
};