const { sql, poolPromise } = require("../config/sql");

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

  const request = pool.request();

  request.input("offset", sql.Int, offset);
  request.input("limit", sql.Int, limit);
  request.input("search", sql.NVarChar(200), search || null);
  request.input("category", sql.NVarChar(100), category || null);

  const result = await request.query(`
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
    FROM dbo.products
    WHERE
      (
        @search IS NULL
        OR name LIKE '%' + @search + '%'
        OR tags LIKE '%' + @search + '%'
      )
      AND
      (
        @category IS NULL
        OR category_slug = @category
      )
    ORDER BY created_at DESC
    OFFSET @offset ROWS
    FETCH NEXT @limit ROWS ONLY;

    SELECT COUNT(*) AS total
    FROM dbo.products
    WHERE
      (
        @search IS NULL
        OR name LIKE '%' + @search + '%'
        OR tags LIKE '%' + @search + '%'
      )
      AND
      (
        @category IS NULL
        OR category_slug = @category
      );
  `);

  const products = result.recordsets[0];
  const total = result.recordsets[1][0].total;

  // ==========================================
  // ADD IMAGES + VARIANTS
  // ==========================================

  for (const product of products) {

    // ------------------------------------------
    // GET IMAGES
    // ------------------------------------------

    const imageResult = await pool
      .request()
      .input("productId", sql.NVarChar(100), product.id)
      .query(`
        SELECT
          id,
          image_url,
          sort_order,
          is_primary,
          created_at
        FROM dbo.product_images
        WHERE product_id = @productId
        ORDER BY sort_order ASC;
      `);

    product.images = imageResult.recordset;

    // ------------------------------------------
    // GET VARIANTS
    // ------------------------------------------

    const variantResult = await pool
      .request()
      .input("productId", sql.NVarChar(100), product.id)
      .query(`
        SELECT
          id,
          product_id,
          size,
          color,
          inventory,
          sku,
          created_at,
          updated_at
        FROM dbo.product_variants
        WHERE product_id = @productId
        ORDER BY created_at ASC;
      `);

    product.variants = variantResult.recordset;
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

  const result = await pool
    .request()
    .input("slug", sql.NVarChar(200), slug)
    .query(`
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
      FROM dbo.products
      WHERE slug = @slug;
    `);

  if (result.recordset.length === 0) {
    throw new Error("Product not found.");
  }

  const product = result.recordset[0];

  // ==========================================
  // GET PRODUCT IMAGES
  // ==========================================

  const imageResult = await pool
    .request()
    .input("productId", sql.NVarChar(100), product.id)
    .query(`
      SELECT
        id,
        image_url,
        sort_order,
        is_primary,
        created_at
      FROM dbo.product_images
      WHERE product_id = @productId
      ORDER BY sort_order ASC;
    `);

  product.images = imageResult.recordset;

  // ==========================================
  // GET PRODUCT VARIANTS
  // ==========================================

  const variantResult = await pool
    .request()
    .input("productId", sql.NVarChar(100), product.id)
    .query(`
      SELECT
        id,
        product_id,
        size,
        color,
        inventory,
        sku,
        created_at,
        updated_at
      FROM dbo.product_variants
      WHERE product_id = @productId
      ORDER BY created_at ASC;
    `);

  product.variants = variantResult.recordset;

  return product;
};

// ==========================================
// CREATE PRODUCT
// ==========================================

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

  const existing = await pool
    .request()
    .input("id", sql.NVarChar(100), id)
    .input("slug", sql.NVarChar(200), slug)
    .query(`
      SELECT id
      FROM dbo.products
      WHERE id = @id OR slug = @slug;
    `);

  if (existing.recordset.length > 0) {
    throw new Error("Product with this ID or slug already exists.");
  }

  // ==========================================
  // CREATE PRODUCT
  // ==========================================

  await pool
    .request()
    .input("id", sql.NVarChar(100), id)
    .input("slug", sql.NVarChar(200), slug)
    .input("name", sql.NVarChar(200), name)
    .input("categorySlug", sql.NVarChar(100), category_slug || null)
    .input("categoryLabel", sql.NVarChar(150), category_label)
    .input("fit", sql.NVarChar(30), fit)
    .input("fabric", sql.NVarChar(50), fabric)
    .input("coverage", sql.NVarChar(30), coverage)
    .input("price", sql.Decimal(18, 2), price)
    .input("mrp", sql.Decimal(18, 2), mrp)
    .input("bestPrice", sql.Decimal(18, 2), best_price)
    .input("rating", sql.Decimal(3, 2), rating)
    .input("reviewCount", sql.Int, review_count)
    .input("description", sql.NVarChar(sql.MAX), description || null)
    .input("fabricDetails", sql.NVarChar(sql.MAX), fabric_details || null)
    .input("washCare", sql.NVarChar(sql.MAX), wash_care || null)
    .input("tags", sql.NVarChar(sql.MAX), tags)
    .input("bestSeller", sql.Bit, best_seller)
    .input("newArrival", sql.Bit, new_arrival)
    .input("trending", sql.Bit, trending)
    .input("limitedEdition", sql.Bit, limited_edition)
    .input("inventory", sql.Int, inventory)
    .query(`
      INSERT INTO dbo.products
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
        @id,
        @slug,
        @name,
        @categorySlug,
        @categoryLabel,
        @fit,
        @fabric,
        @coverage,
        @price,
        @mrp,
        @bestPrice,
        @rating,
        @reviewCount,
        @description,
        @fabricDetails,
        @washCare,
        @tags,
        @bestSeller,
        @newArrival,
        @trending,
        @limitedEdition,
        @inventory,
        SYSUTCDATETIME(),
        SYSUTCDATETIME()
      );
    `);

  // ==========================================
  // UPLOAD PRODUCT IMAGES
  // ==========================================

  if (files.length > 0) {
    const uploadedImages = await uploadProductImages(files);

    for (let i = 0; i < uploadedImages.length; i++) {
      const image = uploadedImages[i];

      await pool
        .request()
        .input("productId", sql.NVarChar(100), id)
        .input("imageUrl", sql.NVarChar(2048), image.url)
        .input("sortOrder", sql.Int, i)
        .input("isPrimary", sql.Bit, i === 0)
        .query(`
          INSERT INTO dbo.product_images
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
            NEWID(),
            @productId,
            @imageUrl,
            @sortOrder,
            @isPrimary,
            SYSUTCDATETIME()
          );
        `);
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

    await pool
      .request()
      .input("productId", sql.NVarChar(100), id)
      .input("size", sql.NVarChar(10), variant.size)
      .input("color", sql.NVarChar(30), variant.color)
      .input(
        "inventory",
        sql.Int,
        Number(variant.inventory)
      )
      .input(
        "sku",
        sql.NVarChar(100),
        variant.sku || null
      )
      .query(`
        INSERT INTO dbo.product_variants
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
          NEWID(),
          @productId,
          @size,
          @color,
          @inventory,
          @sku,
          SYSUTCDATETIME(),
          SYSUTCDATETIME()
        );
      `);
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

  // ==========================================
  // PARSE VARIANTS
  // ==========================================

  let parsedVariants = null;

  if (variants !== undefined) {
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
  // CHECK PRODUCT
  // ==========================================

  const existing = await pool
    .request()
    .input("id", sql.NVarChar(100), id)
    .query(`
      SELECT id
      FROM dbo.products
      WHERE id = @id;
    `);

  if (existing.recordset.length === 0) {
    throw new Error("Product not found.");
  }

  // ==========================================
  // UPDATE PRODUCT DETAILS
  // ==========================================

  await pool
    .request()
    .input("id", sql.NVarChar(100), id)
    .input("slug", sql.NVarChar(200), slug)
    .input("name", sql.NVarChar(200), name)
    .input("categorySlug", sql.NVarChar(100), category_slug || null)
    .input("categoryLabel", sql.NVarChar(150), category_label)
    .input("fit", sql.NVarChar(30), fit)
    .input("fabric", sql.NVarChar(50), fabric)
    .input("coverage", sql.NVarChar(30), coverage)
    .input("price", sql.Decimal(18, 2), price)
    .input("mrp", sql.Decimal(18, 2), mrp)
    .input("bestPrice", sql.Decimal(18, 2), best_price)
    .input("rating", sql.Decimal(3, 2), rating)
    .input("reviewCount", sql.Int, review_count)
    .input("description", sql.NVarChar(sql.MAX), description || null)
    .input("fabricDetails", sql.NVarChar(sql.MAX), fabric_details || null)
    .input("washCare", sql.NVarChar(sql.MAX), wash_care || null)
    .input("tags", sql.NVarChar(sql.MAX), tags)
    .input("bestSeller", sql.Bit, best_seller)
    .input("newArrival", sql.Bit, new_arrival)
    .input("trending", sql.Bit, trending)
    .input("limitedEdition", sql.Bit, limited_edition)
    .input("inventory", sql.Int, inventory)
    .query(`
      UPDATE dbo.products
      SET
        slug = @slug,
        name = @name,
        category_slug = @categorySlug,
        category_label = @categoryLabel,
        fit = @fit,
        fabric = @fabric,
        coverage = @coverage,
        price = @price,
        mrp = @mrp,
        best_price = @bestPrice,
        rating = @rating,
        review_count = @reviewCount,
        description = @description,
        fabric_details = @fabricDetails,
        wash_care = @washCare,
        tags = @tags,
        best_seller = @bestSeller,
        new_arrival = @newArrival,
        trending = @trending,
        limited_edition = @limitedEdition,
        inventory = @inventory,
        updated_at = SYSUTCDATETIME()
      WHERE id = @id;
    `);

  // ==========================================
  // UPDATE IMAGES
  // ONLY IF NEW FILES PROVIDED
  // ==========================================

  if (files.length > 0) {

    const oldImages = await pool
      .request()
      .input("productId", sql.NVarChar(100), id)
      .query(`
        SELECT image_url
        FROM dbo.product_images
        WHERE product_id = @productId;
      `);

    // ------------------------------------------
    // DELETE OLD CLOUDINARY IMAGES
    // ------------------------------------------

    for (const image of oldImages.recordset) {
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
          "Old Cloudinary image delete failed:",
          error.message
        );
      }
    }

    // ------------------------------------------
    // DELETE OLD IMAGE RECORDS
    // ------------------------------------------

    await pool
      .request()
      .input("productId", sql.NVarChar(100), id)
      .query(`
        DELETE FROM dbo.product_images
        WHERE product_id = @productId;
      `);

    // ------------------------------------------
    // UPLOAD NEW IMAGES
    // ------------------------------------------

    const uploadedImages = await uploadProductImages(files);

    for (let i = 0; i < uploadedImages.length; i++) {
      const image = uploadedImages[i];

      await pool
        .request()
        .input("productId", sql.NVarChar(100), id)
        .input("imageUrl", sql.NVarChar(2048), image.url)
        .input("sortOrder", sql.Int, i)
        .input("isPrimary", sql.Bit, i === 0)
        .query(`
          INSERT INTO dbo.product_images
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
            NEWID(),
            @productId,
            @imageUrl,
            @sortOrder,
            @isPrimary,
            SYSUTCDATETIME()
          );
        `);
    }
  }

  // ==========================================
  // UPDATE VARIANTS
  // ONLY IF VARIANTS FIELD IS PROVIDED
  // ==========================================

  if (parsedVariants !== null) {

    // ------------------------------------------
    // DELETE OLD VARIANTS
    // ------------------------------------------

    await pool
      .request()
      .input("productId", sql.NVarChar(100), id)
      .query(`
        DELETE FROM dbo.product_variants
        WHERE product_id = @productId;
      `);

    // ------------------------------------------
    // CREATE NEW VARIANTS
    // ------------------------------------------

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

      await pool
        .request()
        .input("productId", sql.NVarChar(100), id)
        .input("size", sql.NVarChar(10), variant.size)
        .input("color", sql.NVarChar(30), variant.color)
        .input(
          "inventory",
          sql.Int,
          Number(variant.inventory)
        )
        .input(
          "sku",
          sql.NVarChar(100),
          variant.sku || null
        )
        .query(`
          INSERT INTO dbo.product_variants
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
            NEWID(),
            @productId,
            @size,
            @color,
            @inventory,
            @sku,
            SYSUTCDATETIME(),
            SYSUTCDATETIME()
          );
        `);
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

  const result = await pool
    .request()
    .input("id", sql.NVarChar(100), id)
    .query(`
      SELECT id
      FROM dbo.products
      WHERE id = @id;
    `);

  if (result.recordset.length === 0) {
    throw new Error("Product not found.");
  }

  // ==========================================
  // GET PRODUCT IMAGES
  // ==========================================

  const imageResult = await pool
    .request()
    .input("productId", sql.NVarChar(100), id)
    .query(`
      SELECT image_url
      FROM dbo.product_images
      WHERE product_id = @productId;
    `);

  // ==========================================
  // DELETE IMAGES FROM CLOUDINARY
  // ==========================================

  for (const image of imageResult.recordset) {
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

  await pool
    .request()
    .input("productId", sql.NVarChar(100), id)
    .query(`
      DELETE FROM dbo.product_variants
      WHERE product_id = @productId;
    `);

  // ==========================================
  // DELETE IMAGE RECORDS
  // ==========================================

  await pool
    .request()
    .input("productId", sql.NVarChar(100), id)
    .query(`
      DELETE FROM dbo.product_images
      WHERE product_id = @productId;
    `);

  // ==========================================
  // DELETE PRODUCT
  // ==========================================

  await pool
    .request()
    .input("id", sql.NVarChar(100), id)
    .query(`
      DELETE FROM dbo.products
      WHERE id = @id;
    `);

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