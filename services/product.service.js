const { poolPromise } = require("../config/sql");
const { randomUUID } = require("crypto");

const {
  uploadProductImages,
  deleteProductImage,
} = require("./storage.service");

// ==========================================
// GET ALL PRODUCTS
// ==========================================

const getAllProducts = async ({
  page = 1,
  limit = 20,
  search,
  category,
}) => {
  const pool = await poolPromise;

  const offset = (page - 1) * limit;

  const searchValue = search || null;
  const categoryValue = category || null;

  const [productRows] = await pool.execute(
    `
      SELECT
        id,
        slug,
        name,
        category_slug,
        category_label,
        fit,
        fabric,
        coverage,
        price,
        mrp,
        best_price,
        rating,
        review_count,
        description,
        fabric_details,
        wash_care,
        tags,
        best_seller,
        new_arrival,
        trending,
        limited_edition,
        inventory,
        created_at,
        updated_at
      FROM products
      WHERE
        (
          ? IS NULL
          OR name LIKE CONCAT('%', ?, '%')
          OR tags LIKE CONCAT('%', ?, '%')
        )
        AND
        (
          ? IS NULL
          OR category_slug = ?
        )
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `,
    [
      searchValue,
      searchValue,
      searchValue,
      categoryValue,
      categoryValue,
      Number(limit),
      Number(offset),
    ]
  );

  const [countRows] = await pool.execute(
    `
      SELECT COUNT(*) AS total
      FROM products
      WHERE
        (
          ? IS NULL
          OR name LIKE CONCAT('%', ?, '%')
          OR tags LIKE CONCAT('%', ?, '%')
        )
        AND
        (
          ? IS NULL
          OR category_slug = ?
        )
    `,
    [
      searchValue,
      searchValue,
      searchValue,
      categoryValue,
      categoryValue,
    ]
  );

  const products = productRows;
  const total = Number(countRows[0].total);

  // ==========================================
  // ADD IMAGES + VARIANTS
  // ==========================================

  for (const product of products) {
    // ------------------------------------------
    // GET IMAGES
    // ------------------------------------------

    const [imageRows] = await pool.execute(
      `
        SELECT
          id,
          image_url,
          sort_order,
          is_primary,
          created_at
        FROM product_images
        WHERE product_id = ?
        ORDER BY sort_order ASC
      `,
      [product.id]
    );

    product.images = imageRows;

    // ------------------------------------------
    // GET VARIANTS
    // ------------------------------------------

    const [variantRows] = await pool.execute(
      `
        SELECT
          id,
          product_id,
          size,
          color,
          inventory,
          sku,
          created_at,
          updated_at
        FROM product_variants
        WHERE product_id = ?
        ORDER BY created_at ASC
      `,
      [product.id]
    );

    product.variants = variantRows;
  }

  return {
    products,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
};

// ==========================================
// GET SINGLE PRODUCT BY SLUG
// ==========================================

const getProductBySlug = async (slug) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        slug,
        name,
        category_slug,
        category_label,
        fit,
        fabric,
        coverage,
        price,
        mrp,
        best_price,
        rating,
        review_count,
        description,
        fabric_details,
        wash_care,
        tags,
        best_seller,
        new_arrival,
        trending,
        limited_edition,
        inventory,
        created_at,
        updated_at
      FROM products
      WHERE slug = ?
      LIMIT 1
    `,
    [slug]
  );

  if (rows.length === 0) {
    throw new Error("Product not found.");
  }

  const product = rows[0];

  // ==========================================
  // GET PRODUCT IMAGES
  // ==========================================

  const [imageRows] = await pool.execute(
    `
      SELECT
        id,
        image_url,
        sort_order,
        is_primary,
        created_at
      FROM product_images
      WHERE product_id = ?
      ORDER BY sort_order ASC
    `,
    [product.id]
  );

  product.images = imageRows;

  // ==========================================
  // GET PRODUCT VARIANTS
  // ==========================================

  const [variantRows] = await pool.execute(
    `
      SELECT
        id,
        product_id,
        size,
        color,
        inventory,
        sku,
        created_at,
        updated_at
      FROM product_variants
      WHERE product_id = ?
      ORDER BY created_at ASC
    `,
    [product.id]
  );

  product.variants = variantRows;

  return product;
};

// ==========================================
// CREATE PRODUCT
// ==========================================

// Prices and stock written by the admin API must be real, non-negative numbers.
const assertMoney = (value, label) => {
  if (value === undefined || value === null || value === "") return;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 10000000) {
    throw new Error(`${label} must be a valid non-negative amount.`);
  }
};

const assertStock = (value, label) => {
  if (value === undefined || value === null || value === "") return;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1000000) {
    throw new Error(`${label} must be a whole number of 0 or more.`);
  }
};

const createProduct = async (product, files = []) => {
  const pool = await poolPromise;

  const {
    id,
    slug,
    name,
    category_slug,
    category_label,
    fit,
    fabric,
    coverage,
    price,
    mrp,
    best_price,
    rating = 0,
    review_count = 0,
    description,
    fabric_details,
    wash_care,
    tags,
    best_seller = false,
    new_arrival = false,
    trending = false,
    limited_edition = false,
    inventory = 0,
    variants,
  } = product;

  if (!id || !slug || !name) {
    throw new Error("Product id, slug and name are required.");
  }

  assertMoney(price, "Price");
  assertMoney(mrp, "MRP");
  assertMoney(best_price, "Best price");
  assertStock(inventory, "Inventory");

  // ==========================================
  // PARSE VARIANTS
  // ==========================================

  let parsedVariants = [];

  if (variants) {
    try {
      parsedVariants =
        typeof variants === "string"
          ? JSON.parse(variants)
          : variants;
    } catch (error) {
      throw new Error("Invalid variants JSON format.");
    }

    if (!Array.isArray(parsedVariants)) {
      throw new Error("Variants must be an array.");
    }
  }

  // ==========================================
  // CHECK DUPLICATE PRODUCT
  // ==========================================

  const [existingRows] = await pool.execute(
    `
      SELECT id
      FROM products
      WHERE id = ? OR slug = ?
      LIMIT 1
    `,
    [id, slug]
  );

  if (existingRows.length > 0) {
    throw new Error("Product with this ID or slug already exists.");
  }

  // ==========================================
  // CREATE PRODUCT
  // ==========================================

  await pool.execute(
    `
      INSERT INTO products
      (
        id,
        slug,
        name,
        category_slug,
        category_label,
        fit,
        fabric,
        coverage,
        price,
        mrp,
        best_price,
        rating,
        review_count,
        description,
        fabric_details,
        wash_care,
        tags,
        best_seller,
        new_arrival,
        trending,
        limited_edition,
        inventory,
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
      id,
      slug,
      name,
      category_slug || null,
      category_label,
      fit,
      fabric,
      coverage,
      price,
      mrp,
      best_price,
      rating,
      review_count,
      description || null,
      fabric_details || null,
      wash_care || null,
      tags,
      best_seller ? 1 : 0,
      new_arrival ? 1 : 0,
      trending ? 1 : 0,
      limited_edition ? 1 : 0,
      inventory,
    ]
  );

  // ==========================================
  // UPLOAD PRODUCT IMAGES
  // ==========================================

  if (files.length > 0) {
    const uploadedImages = await uploadProductImages(files);

    for (let i = 0; i < uploadedImages.length; i++) {
      const image = uploadedImages[i];

      await pool.execute(
        `
          INSERT INTO product_images
          (
            id,
            product_id,
            image_url,
            sort_order,
            is_primary,
            created_at
          )
          VALUES
          (
            ?,
            ?,
            ?,
            ?,
            ?,
            UTC_TIMESTAMP(6)
          )
        `,
        [
          randomUUID(),
          id,
          image.url,
          i,
          i === 0 ? 1 : 0,
        ]
      );
    }
  }

  // ==========================================
  // CREATE PRODUCT VARIANTS
  // ==========================================

  for (const variant of parsedVariants) {
    if (
      !variant.size ||
      !variant.color ||
      variant.inventory === undefined
    ) {
      throw new Error(
        "Each variant requires size, color and inventory."
      );
    }

    assertStock(variant.inventory, "Variant inventory");

    await pool.execute(
      `
        INSERT INTO product_variants
        (
          id,
          product_id,
          size,
          color,
          inventory,
          sku,
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
          UTC_TIMESTAMP(6),
          UTC_TIMESTAMP(6)
        )
      `,
      [
        randomUUID(),
        id,
        variant.size,
        variant.color,
        Number(variant.inventory),
        variant.sku || null,
      ]
    );
  }

  return getProductBySlug(slug);
};

// ==========================================
// UPDATE PRODUCT
// ==========================================


const updateProduct = async (id, product, files = []) => {
  const pool = await poolPromise;

  const {
    slug,
    name,
    category_slug,
    category_label,
    fit,
    fabric,
    coverage,
    price,
    mrp,
    best_price,
    rating,
    review_count,
    description,
    fabric_details,
    wash_care,
    tags,
    best_seller,
    new_arrival,
    trending,
    limited_edition,
    inventory,
    variants,
  } = product;

  let parsedVariants = null;

  if (variants !== undefined) {
    try {
      parsedVariants =
        typeof variants === "string"
          ? JSON.parse(variants)
          : variants;
    } catch {
      throw new Error("Invalid variants JSON format.");
    }

    if (!Array.isArray(parsedVariants)) {
      throw new Error("Variants must be an array.");
    }
  }

  const [existingRows] = await pool.execute(
    "SELECT id FROM products WHERE id = ? LIMIT 1",
    [id]
  );

  if (existingRows.length === 0) {
    throw new Error("Product not found.");
  }

  assertMoney(price, "Price");
  assertMoney(mrp, "MRP");
  assertMoney(best_price, "Best price");
  assertStock(inventory, "Inventory");

  await pool.execute(
    `
      UPDATE products SET
        slug = ?,
        name = ?,
        category_slug = ?,
        category_label = ?,
        fit = ?,
        fabric = ?,
        coverage = ?,
        price = ?,
        mrp = ?,
        best_price = ?,
        rating = ?,
        review_count = ?,
        description = ?,
        fabric_details = ?,
        wash_care = ?,
        tags = ?,
        best_seller = ?,
        new_arrival = ?,
        trending = ?,
        limited_edition = ?,
        inventory = ?,
        updated_at = UTC_TIMESTAMP(6)
      WHERE id = ?
    `,
    [
      slug,
      name,
      category_slug || null,
      category_label,
      fit,
      fabric,
      coverage,
      price,
      mrp,
      best_price,
      rating,
      review_count,
      description || null,
      fabric_details || null,
      wash_care || null,
      tags,
      best_seller ? 1 : 0,
      new_arrival ? 1 : 0,
      trending ? 1 : 0,
      limited_edition ? 1 : 0,
      inventory,
      id,
    ]
  );

  // Update images only when new files are provided.
  if (files.length > 0) {
    const [oldImages] = await pool.execute(
      "SELECT image_url FROM product_images WHERE product_id = ?",
      [id]
    );

    for (const image of oldImages) {
      try {
        const url = image.image_url;
        const uploadIndex = url.indexOf("/upload/");

        if (uploadIndex !== -1) {
          let publicId = url.substring(uploadIndex + 8);
          publicId = publicId.replace(/^v\d+\//, "");

          const extensionIndex = publicId.lastIndexOf(".");
          if (extensionIndex !== -1) {
            publicId = publicId.substring(0, extensionIndex);
          }

          await deleteProductImage(publicId);
        }
      } catch (error) {
        console.error(
          "Old Cloudinary image delete failed:",
          error.message
        );
      }
    }

    await pool.execute(
      "DELETE FROM product_images WHERE product_id = ?",
      [id]
    );

    const uploadedImages = await uploadProductImages(files);

    for (let i = 0; i < uploadedImages.length; i++) {
      await pool.execute(
        `
          INSERT INTO product_images
            (id, product_id, image_url, sort_order, is_primary, created_at)
          VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))
        `,
        [
          randomUUID(),
          id,
          uploadedImages[i].url,
          i,
          i === 0 ? 1 : 0,
        ]
      );
    }
  }

  // Update variants without replacing existing IDs.
  if (parsedVariants !== null) {
    const [existingVariants] = await pool.execute(
      `
        SELECT id, size, color
        FROM product_variants
        WHERE product_id = ?
      `,
      [id]
    );

    const processedIds = new Set();

    for (const variant of parsedVariants) {
      if (
        !variant.size ||
        !variant.color ||
        variant.inventory === undefined ||
        !Number.isFinite(Number(variant.inventory)) ||
        Number(variant.inventory) < 0
      ) {
        throw new Error(
          "Each variant requires size, color and valid inventory."
        );
      }

      let existing = variant.id
        ? existingVariants.find(
            (item) =>
              String(item.id) === String(variant.id) &&
              !processedIds.has(String(item.id))
          )
        : null;

      if (!existing) {
        existing = existingVariants.find(
          (item) =>
            String(item.size).toLowerCase() ===
              String(variant.size).toLowerCase() &&
            String(item.color).toLowerCase() ===
              String(variant.color).toLowerCase() &&
            !processedIds.has(String(item.id))
        );
      }

      if (existing) {
        await pool.execute(
          `
            UPDATE product_variants SET
              size = ?,
              color = ?,
              inventory = ?,
              sku = ?,
              updated_at = UTC_TIMESTAMP(6)
            WHERE id = ? AND product_id = ?
          `,
          [
            variant.size,
            variant.color,
            Number(variant.inventory),
            variant.sku || null,
            existing.id,
            id,
          ]
        );

        processedIds.add(String(existing.id));
      } else {
        await pool.execute(
          `
            INSERT INTO product_variants
              (id, product_id, size, color, inventory, sku,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
          `,
          [
            randomUUID(),
            id,
            variant.size,
            variant.color,
            Number(variant.inventory),
            variant.sku || null,
          ]
        );
      }
    }

    // Delete omitted variants only if no order references them.
    for (const existing of existingVariants) {
      if (processedIds.has(String(existing.id))) {
        continue;
      }

      const [orderRows] = await pool.execute(
        `
          SELECT 1
          FROM order_items
          WHERE variant_id = ?
          LIMIT 1
        `,
        [existing.id]
      );

      if (orderRows.length === 0) {
        await pool.execute(
          `
            DELETE FROM product_variants
            WHERE id = ? AND product_id = ?
          `,
          [existing.id, id]
        );
      }
    }
  }

  return getProductBySlug(slug);
};


// ==========================================
// DELETE PRODUCT
// ==========================================

const deleteProduct = async (id) => {
  const pool = await poolPromise;

  // ==========================================
  // CHECK PRODUCT
  // ==========================================

  const [productRows] = await pool.execute(
    `
      SELECT id
      FROM products
      WHERE id = ?
      LIMIT 1
    `,
    [id]
  );

  if (productRows.length === 0) {
    throw new Error("Product not found.");
  }

  // ==========================================
  // CHECK IF VARIANTS ARE USED IN ORDERS
  // ==========================================

  const [orderVariantRows] = await pool.execute(
    `
      SELECT pv.id
      FROM product_variants pv
      INNER JOIN order_items oi
        ON oi.variant_id = pv.id
      WHERE pv.product_id = ?
      LIMIT 1
    `,
    [id]
  );

  if (orderVariantRows.length > 0) {
    throw new Error(
      "This product cannot be deleted because one or more of its variants are already used in an order."
    );
  }

  // ==========================================
  // GET PRODUCT IMAGES
  // ==========================================

  const [imageRows] = await pool.execute(
    `
      SELECT image_url
      FROM product_images
      WHERE product_id = ?
    `,
    [id]
  );

  // ==========================================
  // DELETE IMAGES FROM CLOUDINARY
  // ==========================================

  for (const image of imageRows) {
    try {
      const url = image.image_url;

      const uploadIndex = url.indexOf("/upload/");

      if (uploadIndex !== -1) {
        let publicId = url.substring(uploadIndex + 8);

        publicId = publicId.replace(/^v\d+\//, "");

        publicId = publicId.substring(
          0,
          publicId.lastIndexOf(".")
        );

        await deleteProductImage(publicId);
      }
    } catch (error) {
      console.error(
        "Cloudinary image delete failed:",
        error.message
      );
    }
  }

  // ==========================================
  // DELETE VARIANTS
  // ==========================================

  await pool.execute(
    `
      DELETE FROM product_variants
      WHERE product_id = ?
    `,
    [id]
  );

  // ==========================================
  // DELETE IMAGE RECORDS
  // ==========================================

  await pool.execute(
    `
      DELETE FROM product_images
      WHERE product_id = ?
    `,
    [id]
  );

  // ==========================================
  // DELETE PRODUCT
  // ==========================================

  await pool.execute(
    `
      DELETE FROM products
      WHERE id = ?
    `,
    [id]
  );

  return true;
};

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  getAllProducts,
  getProductBySlug,
  createProduct,
  updateProduct,
  deleteProduct,
};