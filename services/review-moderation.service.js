const { poolPromise } = require("../config/sql");
const audit = require("./audit.service");

// ==========================================
// REVIEW MODERATION
//
// Hiding is a reversible status kept in `review_moderation`. The review row in
// `product_reviews` (and its photos, ownership hash and verified-purchase flag)
// is never edited or deleted here, so every customer-facing rule is untouched;
// the public listing simply leaves hidden reviews out. Permanent removal is
// intentionally not offered: reviews have no user column and no soft-delete
// field, so a safe, reversible status is the correct tool.
// ==========================================

const REASON_MIN = 5;
const REASON_MAX = 500;
const HIDDEN_CAP = 5000;

const httpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const cleanText = (value, max) =>
  typeof value === "string"
    ? value
        .normalize("NFC")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

let warned = false;

// Ids of hidden reviews for one product. Used by the public review listing, so
// it must never break it: if the moderation table is not installed yet (or the
// lookup fails) the listing behaves exactly as it did before.
const hiddenReviewIds = async (pool, productId) => {
  try {
    const [rows] = await pool.execute(
      "SELECT review_id FROM review_moderation WHERE product_id = ? AND status = 'hidden'",
      [productId]
    );
    return rows.map((row) => String(row.review_id));
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn(
        "Review moderation unavailable (apply admin_controls_phase1.sql):",
        error.code || error.message
      );
    }
    return [];
  }
};

const toIso = (value) => (value instanceof Date ? value.toISOString() : value ? String(value) : null);

const listForAdmin = async ({ page, limit, status, rating, search, productSlug } = {}) => {
  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
  const pool = await poolPromise;

  const where = [];
  const params = [];

  let hiddenAll = [];
  try {
    const [hiddenRows] = await pool.execute(
      `SELECT review_id FROM review_moderation WHERE status = 'hidden' LIMIT ${HIDDEN_CAP}`
    );
    hiddenAll = hiddenRows.map((row) => String(row.review_id));
  } catch (error) {
    throw httpError(
      503,
      "Review moderation is not available yet. The database update has not been applied."
    );
  }

  if (status === "hidden") {
    if (hiddenAll.length === 0) {
      return { reviews: [], pagination: { page: pageNumber, limit: pageSize, total: 0, totalPages: 1 } };
    }
    where.push(`r.id IN (${hiddenAll.map(() => "?").join(", ")})`);
    params.push(...hiddenAll);
  } else if (status === "visible" && hiddenAll.length > 0) {
    where.push(`r.id NOT IN (${hiddenAll.map(() => "?").join(", ")})`);
    params.push(...hiddenAll);
  }

  const stars = Number(rating);
  if (Number.isInteger(stars) && stars >= 1 && stars <= 5) {
    where.push("ROUND(r.rating) = ?");
    params.push(stars);
  }

  if (typeof productSlug === "string" && productSlug.trim()) {
    where.push("p.slug = ?");
    params.push(productSlug.trim().slice(0, 200));
  }

  const term = cleanText(search, 100);
  if (term) {
    const like = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    where.push("(p.name LIKE ? OR r.title LIKE ? OR r.comment LIKE ? OR r.author_name LIKE ?)");
    params.push(like, like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [[countRow], [rows]] = await Promise.all([
    pool.execute(
      `SELECT COUNT(*) AS total FROM product_reviews r INNER JOIN products p ON p.id = r.product_id ${whereSql}`,
      params
    ),
    pool.execute(
      `
        SELECT r.id, r.product_id, p.name AS product_name, p.slug AS product_slug,
               r.author_name, r.rating, r.title, r.comment, r.verified,
               DATE_FORMAT(r.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
        FROM product_reviews r
        INNER JOIN products p ON p.id = r.product_id
        ${whereSql}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${pageSize} OFFSET ${(pageNumber - 1) * pageSize}
      `,
      params
    ),
  ]);

  const ids = rows.map((row) => String(row.id));
  const moderation = new Map();

  if (ids.length > 0) {
    const [modRows] = await pool.execute(
      `SELECT review_id, status, reason, moderated_by,
              DATE_FORMAT(moderated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS moderated_at
       FROM review_moderation WHERE review_id IN (${ids.map(() => "?").join(", ")})`,
      ids
    );
    const actorIds = [...new Set(modRows.map((row) => row.moderated_by).filter(Boolean))];
    const actors = new Map();
    if (actorIds.length > 0) {
      const [people] = await pool.execute(
        `SELECT id, full_name, email FROM profiles WHERE id IN (${actorIds.map(() => "?").join(", ")})`,
        actorIds
      );
      for (const person of people) actors.set(String(person.id), person.full_name || person.email);
    }
    for (const row of modRows) {
      moderation.set(String(row.review_id), {
        status: row.status,
        reason: row.reason,
        by: actors.get(String(row.moderated_by)) || "Unknown admin",
        at: toIso(row.moderated_at),
      });
    }
  }

  const total = Number(countRow[0]?.total || 0);

  return {
    reviews: rows.map((row) => {
      const mod = moderation.get(String(row.id)) || null;
      return {
        id: row.id,
        productId: row.product_id,
        productName: row.product_name,
        productSlug: row.product_slug,
        authorName: row.author_name || "KOVENIK Customer",
        rating: Number(row.rating),
        title: row.title || "",
        comment: row.comment || "",
        verified: Number(row.verified) === 1,
        createdAt: toIso(row.created_at),
        hidden: Boolean(mod && mod.status === "hidden"),
        moderation: mod,
      };
    }),
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    },
  };
};

// action: "hide" | "unhide". Idempotent: asking for the state a review is
// already in is a 409, never a second log entry.
const moderate = async ({ reviewId, action, reason, actor }) => {
  if (action !== "hide" && action !== "unhide") {
    throw httpError(400, "Action must be hide or unhide.");
  }

  const cleanReason = cleanText(reason, REASON_MAX);
  if (cleanReason.length < REASON_MIN) {
    throw httpError(400, `Please give a reason of at least ${REASON_MIN} characters.`);
  }

  if (typeof reviewId !== "string" || !reviewId || reviewId.length > 64) {
    throw httpError(400, "Invalid review id.");
  }

  const pool = await poolPromise;

  const [reviews] = await pool.execute(
    "SELECT id, product_id, rating, title FROM product_reviews WHERE id = ? LIMIT 1",
    [reviewId]
  );
  if (reviews.length === 0) throw httpError(404, "Review not found.");
  const review = reviews[0];

  let current;
  try {
    const [existing] = await pool.execute(
      "SELECT status FROM review_moderation WHERE review_id = ? LIMIT 1",
      [reviewId]
    );
    current = existing[0]?.status || "visible";
  } catch {
    throw httpError(
      503,
      "Review moderation is not available yet. The database update has not been applied."
    );
  }

  const target = action === "hide" ? "hidden" : "visible";
  if (current === target) {
    throw httpError(
      409,
      target === "hidden" ? "This review is already hidden." : "This review is already visible."
    );
  }

  await pool.execute(
    `
      INSERT INTO review_moderation
        (review_id, product_id, status, reason, moderated_by, moderated_at)
      VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        reason = VALUES(reason),
        moderated_by = VALUES(moderated_by),
        moderated_at = VALUES(moderated_at)
    `,
    [reviewId, review.product_id, target, cleanReason, actor.id]
  );

  await audit.record({
    actor,
    action: action === "hide" ? "review.hide" : "review.unhide",
    resourceType: "review",
    resourceId: reviewId,
    reason: cleanReason,
    before: { status: current },
    after: { status: target, productId: review.product_id, rating: review.rating },
  });

  return { id: reviewId, hidden: target === "hidden", reason: cleanReason };
};

module.exports = { hiddenReviewIds, listForAdmin, moderate };
