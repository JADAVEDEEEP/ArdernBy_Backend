const crypto = require("crypto");
const { poolPromise } = require("../config/sql");
const storage = require("./storage.service");
const { hiddenReviewIds } = require("./review-moderation.service");

const TITLE_MIN = 3;
const TITLE_MAX = 100;
const COMMENT_MIN = 10;
const COMMENT_MAX = 2000;
const PAGE_SIZE_DEFAULT = 6;
const PAGE_SIZE_MAX = 20;
const MAX_PHOTOS = 3;

const httpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

// product_reviews has no user column, so ownership is carried by the primary
// key: id = hash(customer, product). The server derives it from the
// authenticated token, so nobody can address (edit/delete) another customer's
// review, and a customer can have only one review per product.
const reviewId = (userId, productId) =>
  "rv_" +
  crypto.createHash("sha256").update(`${userId}:${productId}`).digest("hex").slice(0, 40);

const UNSAFE_CHARS = new RegExp(
  "[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏  ﻿]",
  "g"
);

// Strips control characters and collapses runs of spaces; keeps line breaks in
// the comment. Output is escaped by React on render, so no HTML handling here.
const clean = (value, { multiline = false } = {}) => {
  if (typeof value !== "string") return "";
  let text = value.normalize("NFC").replace(/\r\n?/g, "\n");
  text = text.replace(UNSAFE_CHARS, "");
  text = multiline
    ? text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n")
    : text.replace(/\s+/g, " ");
  return text.trim();
};

const validateReviewInput = (body = {}) => {
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error("Please choose a star rating from 1 to 5.");
  }

  const title = clean(body.title);
  if (title.length < TITLE_MIN) {
    throw new Error(`Review title must be at least ${TITLE_MIN} characters.`);
  }
  if (title.length > TITLE_MAX) {
    throw new Error(`Review title must be ${TITLE_MAX} characters or fewer.`);
  }

  const comment = clean(body.comment, { multiline: true });
  if (comment.length < COMMENT_MIN) {
    throw new Error(`Review must be at least ${COMMENT_MIN} characters.`);
  }
  if (comment.length > COMMENT_MAX) {
    throw new Error(`Review must be ${COMMENT_MAX} characters or fewer.`);
  }

  return { rating, title, comment };
};

const requireProduct = async (pool, slug) => {
  let product = null;
  if (typeof slug === "string" && slug && slug.length <= 200) {
    const [rows] = await pool.execute(
      "SELECT id, slug, name FROM products WHERE slug = ? LIMIT 1",
      [slug]
    );
    product = rows[0] || null;
  }
  if (!product) throw httpError(404, "Product not found.");
  return product;
};

// Only a DELIVERED order line for this product, owned by this customer, proves
// a received purchase. Cancelled, returned, shipped-but-not-delivered and
// pending orders never qualify.
const hasDeliveredPurchase = async (pool, userId, productId) => {
  const [rows] = await pool.execute(
    `
      SELECT 1
      FROM orders o
      INNER JOIN order_items oi ON oi.order_id = o.id
      WHERE o.user_id = ?
        AND oi.product_id = ?
        AND o.status = 'Delivered'
      LIMIT 1
    `,
    [userId, productId]
  );
  return rows.length > 0;
};

const toDateString = (value) => {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return value ? String(value).slice(0, 10) : null;
};

// ---- photos (table is optional until scripts/sql/product_review_photos.sql is applied)

const photosAvailable = async (pool) => {
  try {
    await pool.execute("SELECT 1 FROM product_review_photos LIMIT 1");
    return true;
  } catch {
    return false;
  }
};

const loadPhotos = async (pool, reviewIds) => {
  const byReview = new Map();
  if (reviewIds.length === 0) return byReview;
  try {
    const [rows] = await pool.execute(
      `
        SELECT id, review_id, url
        FROM product_review_photos
        WHERE review_id IN (${reviewIds.map(() => "?").join(", ")})
        ORDER BY created_at ASC, id ASC
      `,
      reviewIds
    );
    for (const row of rows) {
      if (!byReview.has(row.review_id)) byReview.set(row.review_id, []);
      byReview.get(row.review_id).push({ id: row.id, url: row.url });
    }
  } catch {
    // Photos are optional; reviews still render without them.
  }
  return byReview;
};

// Size / colour the reviewer actually received, read from their delivered
// order line. The review row has no variant column, so it is matched through the
// same hash that makes up the review id.
const loadVariants = async (pool, productId, reviewIds) => {
  const byReview = new Map();
  if (reviewIds.length === 0) return byReview;
  try {
    const [rows] = await pool.execute(
      `
        SELECT
          CONCAT('rv_', LEFT(SHA2(CONCAT(o.user_id, ':', oi.product_id), 256), 40)) AS rid,
          oi.size,
          oi.color
        FROM orders o
        INNER JOIN order_items oi ON oi.order_id = o.id
        WHERE oi.product_id = ?
          AND o.status = 'Delivered'
          AND CONCAT('rv_', LEFT(SHA2(CONCAT(o.user_id, ':', oi.product_id), 256), 40))
              IN (${reviewIds.map(() => "?").join(", ")})
        ORDER BY o.created_at DESC
      `,
      [productId, ...reviewIds]
    );
    for (const row of rows) {
      if (byReview.has(row.rid)) continue;
      const label = [row.size, row.color].filter(Boolean).join(" / ");
      if (label) byReview.set(row.rid, label);
    }
  } catch {
    // Variant label is a nicety; never fail the listing over it.
  }
  return byReview;
};

// The review row only stores a name snapshot taken when it was posted. Show the
// reviewer's CURRENT profile name instead, matched through the same hash that
// makes up the review id (the client never supplies any identity). Falls back
// to the stored snapshot, then to a neutral label. Never the email.
const loadAuthors = async (pool, productId, reviewIds) => {
  const byReview = new Map();
  if (reviewIds.length === 0) return byReview;
  try {
    const [rows] = await pool.execute(
      `
        SELECT p.full_name,
          CONCAT('rv_', LEFT(SHA2(CONCAT(p.id, ':', ?), 256), 40)) AS rid
        FROM profiles p
        WHERE CONCAT('rv_', LEFT(SHA2(CONCAT(p.id, ':', ?), 256), 40))
              IN (${reviewIds.map(() => "?").join(", ")})
      `,
      [productId, productId, ...reviewIds]
    );
    for (const row of rows) {
      const name = clean(row.full_name || "").slice(0, 150);
      if (name) byReview.set(row.rid, name);
    }
  } catch {
    // Name lookup is a nicety; the stored snapshot still renders.
  }
  return byReview;
};

const shapeReviews = async (pool, productId, rows) => {
  const ids = rows.map((row) => row.id);
  const [photos, variants, authors] = await Promise.all([
    loadPhotos(pool, ids),
    loadVariants(pool, productId, ids),
    loadAuthors(pool, productId, ids),
  ]);
  return rows.map((row) => ({
    id: row.id,
    authorName: authors.get(row.id) || clean(row.author_name || "") || "KOVENIK Customer",
    rating: Number(row.rating),
    date: toDateString(row.review_date),
    title: row.title || "",
    comment: row.comment || "",
    verified: Number(row.verified) === 1,
    variant: variants.get(row.id) || null,
    photos: photos.get(row.id) || [],
  }));
};

const getReviews = async ({ slug, page = 1, limit = PAGE_SIZE_DEFAULT }) => {
  const pool = await poolPromise;
  const product = await requireProduct(pool, slug);

  const pageSize = Math.min(Math.max(parseInt(limit, 10) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);
  const currentPage = Math.max(parseInt(page, 10) || 1, 1);

  // Reviews hidden by an admin are left out of the list AND the totals.
  const hidden = await hiddenReviewIds(pool, product.id);
  const visibleOnly = hidden.length ? ` AND id NOT IN (${hidden.map(() => "?").join(", ")})` : "";

  const [statRows] = await pool.execute(
    `
      SELECT ROUND(rating) AS stars, COUNT(*) AS total, SUM(rating) AS sum_rating
      FROM product_reviews
      WHERE product_id = ?${visibleOnly}
      GROUP BY ROUND(rating)
    `,
    [product.id, ...hidden]
  );

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let sum = 0;
  for (const row of statRows) {
    const stars = Number(row.stars);
    if (stars >= 1 && stars <= 5) distribution[stars] = Number(row.total);
    count += Number(row.total);
    sum += Number(row.sum_rating);
  }
  const average = count > 0 ? Math.round((sum / count) * 10) / 10 : 0;

  // LIMIT/OFFSET are validated integers, interpolated because mysql2 prepared
  // statements reject them as bound parameters on some servers.
  const offset = (currentPage - 1) * pageSize;
  const [rows] = await pool.execute(
    `
      SELECT id, author_name, rating, review_date, title, comment, verified, created_at
      FROM product_reviews
      WHERE product_id = ?${visibleOnly}
      ORDER BY created_at DESC, id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `,
    [product.id, ...hidden]
  );

  return {
    summary: { average, count, distribution },
    reviews: await shapeReviews(pool, product.id, rows),
    page: currentPage,
    pageSize,
    hasMore: offset + rows.length < count,
  };
};

const findOwnReview = async (pool, userId, productId) => {
  const [rows] = await pool.execute(
    `
      SELECT id, author_name, rating, review_date, title, comment, verified, created_at
      FROM product_reviews
      WHERE id = ? AND product_id = ?
      LIMIT 1
    `,
    [reviewId(userId, productId), productId]
  );
  if (rows.length === 0) return null;
  return (await shapeReviews(pool, productId, rows))[0];
};

// What the signed-in customer may do on this product (drives the form UI).
const getEligibility = async ({ slug, userId }) => {
  const pool = await poolPromise;
  const product = await requireProduct(pool, slug);
  const myReview = await findOwnReview(pool, userId, product.id);
  const deliveredPurchase = await hasDeliveredPurchase(pool, userId, product.id);
  return {
    canReview: deliveredPurchase && !myReview,
    verifiedPurchase: deliveredPurchase,
    alreadyReviewed: Boolean(myReview),
    myReview,
    photosEnabled: await photosAvailable(pool),
  };
};

const checkPhotoUploads = async (pool, files) => {
  if (files.length > MAX_PHOTOS) {
    throw new Error(`You can add up to ${MAX_PHOTOS} photos.`);
  }
  if (files.length > 0 && !(await photosAvailable(pool))) {
    throw httpError(503, "Photo uploads are not available right now. Please post without photos.");
  }
};

const insertPhotos = async (pool, rid, uploaded) => {
  for (const item of uploaded) {
    await pool.execute(
      "INSERT INTO product_review_photos (id, review_id, url, public_id) VALUES (?, ?, ?, ?)",
      [crypto.randomUUID(), rid, item.url, item.publicId]
    );
  }
};

const uploadPhotos = async (files) => {
  if (files.length === 0) return [];
  try {
    return await storage.uploadReviewImages(files);
  } catch (error) {
    console.error("Review photo upload failed:", error.message);
    throw httpError(502, "Your photos could not be uploaded. Please try again.");
  }
};

const destroyUploaded = (uploaded) =>
  Promise.all(uploaded.map((item) => storage.deleteProductImage(item.publicId).catch(() => {})));

const createReview = async ({ slug, userId, body, files = [] }) => {
  const input = validateReviewInput(body);

  const pool = await poolPromise;
  const product = await requireProduct(pool, slug);
  const id = reviewId(userId, product.id);

  const [existing] = await pool.execute(
    "SELECT id FROM product_reviews WHERE id = ? LIMIT 1",
    [id]
  );
  if (existing.length > 0) throw httpError(409, "You have already reviewed this product.");

  if (!(await hasDeliveredPurchase(pool, userId, product.id))) {
    throw httpError(
      403,
      "Only customers who have received this product can review it. You can review it once your order is delivered."
    );
  }

  await checkPhotoUploads(pool, files);

  const [profiles] = await pool.execute(
    "SELECT full_name FROM profiles WHERE id = ? LIMIT 1",
    [userId]
  );
  // Never fall back to the email address; it is private.
  const authorName = clean(profiles[0]?.full_name || "").slice(0, 150) || "KOVENIK Customer";

  const uploaded = await uploadPhotos(files);

  try {
    // review_date and created_at come from their column defaults (curdate / now).
    await pool.execute(
      `
        INSERT INTO product_reviews
          (id, product_id, author_name, rating, title, comment, verified)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `,
      [id, product.id, authorName, input.rating, input.title, input.comment]
    );
    await insertPhotos(pool, id, uploaded);
  } catch (error) {
    await destroyUploaded(uploaded);
    if (error && (error.code === "ER_DUP_ENTRY" || error.errno === 1062)) {
      throw httpError(409, "You have already reviewed this product.");
    }
    throw error;
  }

  return { id, verified: true };
};

const parseIdList = (value) => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

// Edits only ever touch the review whose id is derived from the caller's token.
const updateOwnReview = async ({ slug, userId, body, files = [] }) => {
  const input = validateReviewInput(body);

  const pool = await poolPromise;
  const product = await requireProduct(pool, slug);
  const id = reviewId(userId, product.id);

  const mine = await findOwnReview(pool, userId, product.id);
  if (!mine) throw httpError(404, "You have not reviewed this product.");

  const removeIds = parseIdList(body.removePhotos).filter((photoId) =>
    mine.photos.some((photo) => photo.id === photoId)
  );
  const remaining = mine.photos.length - removeIds.length;
  if (remaining + files.length > MAX_PHOTOS) {
    throw new Error(`You can have up to ${MAX_PHOTOS} photos on a review.`);
  }
  await checkPhotoUploads(pool, files);

  const uploaded = await uploadPhotos(files);

  try {
    await pool.execute(
      "UPDATE product_reviews SET rating = ?, title = ?, comment = ? WHERE id = ?",
      [input.rating, input.title, input.comment, id]
    );
    await insertPhotos(pool, id, uploaded);
  } catch (error) {
    await destroyUploaded(uploaded);
    throw error;
  }

  for (const photoId of removeIds) {
    const [rows] = await pool.execute(
      "SELECT public_id FROM product_review_photos WHERE id = ? AND review_id = ?",
      [photoId, id]
    );
    await pool.execute("DELETE FROM product_review_photos WHERE id = ? AND review_id = ?", [
      photoId,
      id,
    ]);
    if (rows[0]?.public_id) await storage.deleteProductImage(rows[0].public_id).catch(() => {});
  }

  return { id };
};

const deleteOwnReview = async ({ slug, userId }) => {
  const pool = await poolPromise;
  const product = await requireProduct(pool, slug);
  const id = reviewId(userId, product.id);

  const mine = await findOwnReview(pool, userId, product.id);
  if (!mine) throw httpError(404, "You have not reviewed this product.");

  let publicIds = [];
  try {
    const [rows] = await pool.execute(
      "SELECT public_id FROM product_review_photos WHERE review_id = ?",
      [id]
    );
    publicIds = rows.map((row) => row.public_id).filter(Boolean);
    await pool.execute("DELETE FROM product_review_photos WHERE review_id = ?", [id]);
  } catch {
    // photos table not installed: nothing to clean up
  }

  await pool.execute("DELETE FROM product_reviews WHERE id = ? AND product_id = ?", [
    id,
    product.id,
  ]);
  await Promise.all(publicIds.map((publicId) => storage.deleteProductImage(publicId).catch(() => {})));

  return { id };
};

module.exports = {
  getReviews,
  getEligibility,
  createReview,
  updateOwnReview,
  deleteOwnReview,
  validateReviewInput,
  reviewId,
  MAX_PHOTOS,
};
