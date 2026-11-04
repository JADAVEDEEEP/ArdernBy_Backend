const { randomUUID } = require("crypto");
const { poolPromise } = require("../config/sql");
const cloudinary = require("../config/cloudinary");

// ==========================================
// HOMEPAGE BANNERS
//
// Rows live in the existing `editorial_banners` table; the extra columns come
// from scripts/sql/editorial_banners_phase1.sql. Start / end dates are stored
// in UTC and compared in SQL against UTC_TIMESTAMP(), so the result does not
// depend on the time zone of the server or of the database session.
// ==========================================

const httpError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

// Missing table / column: the migration has not been applied yet.
const notReady = (error) =>
  Boolean(error) && [1146, 1054].includes(error.errno);

const NOT_READY_MESSAGE =
  "Banner management is not available yet: the database update has not been applied.";

const MAX_BANNERS = 50;
const MAX_NAME = 200;
const MAX_URL = 2048;
const MAX_SORT = 9999;

const UTC_FMT = "%Y-%m-%dT%H:%i:%sZ";

const SELECT_COLUMNS = `
  id,
  name,
  image_url,
  mobile_image_url,
  link_url,
  active,
  sort_order,
  DATE_FORMAT(start_at, '${UTC_FMT}') AS start_at,
  DATE_FORMAT(end_at, '${UTC_FMT}') AS end_at,
  DATE_FORMAT(created_at, '${UTC_FMT}') AS created_at,
  (start_at IS NOT NULL AND start_at > UTC_TIMESTAMP()) AS is_upcoming,
  (end_at IS NOT NULL AND end_at <= UTC_TIMESTAMP()) AS is_expired
`;

// ---- validation -------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

const cleanName = (value) => {
  if (typeof value !== "string" || !value.trim()) throw httpError("Banner title is required.");
  const name = value.trim();
  if (name.length > MAX_NAME) throw httpError(`Banner title must be at most ${MAX_NAME} characters.`);
  if (CONTROL_CHARS.test(name)) throw httpError("Banner title contains invalid characters.");
  return name;
};

// Absolute http(s) URL or a site path such as /shop. Anything else (javascript:,
// data:, protocol-relative //host) is refused: the link is opened by customers.
const cleanLink = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw httpError("Destination link must be text.");
  const link = value.trim();
  if (!link) return null;
  if (link.length > MAX_URL) throw httpError(`Destination link must be at most ${MAX_URL} characters.`);
  if (CONTROL_CHARS.test(link) || /\s/.test(link)) throw httpError("Destination link is not valid.");

  if (link.startsWith("/")) {
    if (link.startsWith("//") || link.includes("\\")) throw httpError("Destination link is not valid.");
    return link;
  }

  let parsed;
  try {
    parsed = new URL(link);
  } catch {
    throw httpError("Destination link must be a full http(s) URL or a path starting with /.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw httpError("Destination link must start with http://, https:// or /.");
  }
  return link;
};

// ISO string (or anything Date parses unambiguously) -> UTC "YYYY-MM-DD HH:MM:SS".
const cleanDate = (label, value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw httpError(`${label} is not a valid date.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) {
    throw httpError(`${label} is not a valid date.`);
  }
  return date.toISOString().slice(0, 19).replace("T", " ");
};

const cleanSort = (value) => {
  const n = Number(value);
  if (value === "" || !Number.isInteger(n) || n < 0 || n > MAX_SORT) {
    throw httpError(`Display order must be a whole number from 0 to ${MAX_SORT}.`);
  }
  return n;
};

const cleanActive = (value) => {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  throw httpError("Active must be on or off.");
};

const checkWindow = (startAt, endAt) => {
  if (startAt && endAt && endAt <= startAt) {
    throw httpError("End date must be after the start date.");
  }
};

// ---- shaping ----------------------------------------------------------------

const statusOf = (row) => {
  if (!row.active) return "inactive";
  if (row.is_expired) return "expired";
  if (row.is_upcoming) return "scheduled";
  return "live";
};

const toAdmin = (row) => ({
  id: row.id,
  name: row.name,
  imageUrl: row.image_url,
  mobileImageUrl: row.mobile_image_url || null,
  linkUrl: row.link_url || null,
  active: Boolean(row.active),
  sortOrder: Number(row.sort_order) || 0,
  startAt: row.start_at || null,
  endAt: row.end_at || null,
  createdAt: row.created_at || null,
  status: statusOf(row),
});

const toPublic = (row) => ({
  id: row.id,
  name: row.name,
  imageUrl: row.image_url,
  mobileImageUrl: row.mobile_image_url || null,
  linkUrl: row.link_url || null,
  sortOrder: Number(row.sort_order) || 0,
});

// ---- images -----------------------------------------------------------------

const uploadBannerImage = (file) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "ardenby/banners",
        resource_type: "image",
        // Large enough for a full-bleed hero, re-encoded so a raw upload is never served.
        transformation: [{ width: 2400, height: 2400, crop: "limit", quality: "auto", fetch_format: "auto" }],
      },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(file.buffer);
  });

// Public id of one of OUR banner uploads, or null for any other URL (a pasted
// external image must never be passed to the Cloudinary destroy call).
const bannerPublicId = (url) => {
  if (typeof url !== "string") return null;
  const match = /\/image\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(ardenby\/banners\/[A-Za-z0-9_-]+)\.[A-Za-z0-9]+$/.exec(url);
  return match ? match[1] : null;
};

const destroyIfUnused = async (pool, url) => {
  const publicId = bannerPublicId(url);
  if (!publicId) return;

  try {
    const [rows] = await pool.execute(
      "SELECT COUNT(*) AS used FROM editorial_banners WHERE image_url = ? OR mobile_image_url = ?",
      [url, url]
    );
    if (Number(rows[0].used) > 0) return;
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    // The banner change itself succeeded; a leftover image is harmless.
    console.error("Banner image cleanup failed:", error.message);
  }
};

const uploadOrFail = async (file) => {
  try {
    const result = await uploadBannerImage(file);
    return result.secure_url;
  } catch (error) {
    console.error("Banner image upload failed:", error.message);
    throw httpError("The image could not be uploaded. Please try again.", 502);
  }
};

// ---- queries ----------------------------------------------------------------

// Customers: active banners inside their window, in display order.
const listPublic = async () => {
  try {
    const pool = await poolPromise;
    const [rows] = await pool.execute(
      `
        SELECT ${SELECT_COLUMNS}
        FROM editorial_banners
        WHERE active = 1
          AND (start_at IS NULL OR start_at <= UTC_TIMESTAMP())
          AND (end_at IS NULL OR end_at > UTC_TIMESTAMP())
        ORDER BY sort_order ASC, created_at ASC, id ASC
        LIMIT ${MAX_BANNERS}
      `
    );
    return rows.map(toPublic);
  } catch (error) {
    // Before the migration there are simply no banners to show.
    if (notReady(error)) return [];
    throw error;
  }
};

const listAdmin = async () => {
  try {
    const pool = await poolPromise;
    const [rows] = await pool.execute(
      `
        SELECT ${SELECT_COLUMNS}
        FROM editorial_banners
        ORDER BY sort_order ASC, created_at ASC, id ASC
        LIMIT ${MAX_BANNERS}
      `
    );
    return rows.map(toAdmin);
  } catch (error) {
    if (notReady(error)) throw httpError(NOT_READY_MESSAGE, 503);
    throw error;
  }
};

const getOne = async (pool, id) => {
  const [rows] = await pool.execute(
    `SELECT ${SELECT_COLUMNS} FROM editorial_banners WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
};

const requireId = (id) => {
  if (typeof id !== "string" || !id || id.length > 100) throw httpError("Banner not found.", 404);
  return id;
};

// fields: raw body values; files: { image?, mobileImage? } multer file objects.
const create = async (fields, files = {}) => {
  const name = cleanName(fields.name);
  const linkUrl = cleanLink(fields.linkUrl);
  const startAt = cleanDate("Start date", fields.startAt);
  const endAt = cleanDate("End date", fields.endAt);
  checkWindow(startAt, endAt);
  const active = fields.active === undefined ? true : cleanActive(fields.active);
  if (!files.image) throw httpError("Please choose a banner image.");

  const pool = await poolPromise;

  let sortOrder;
  try {
    const [[count]] = await pool.execute("SELECT COUNT(*) AS total, COALESCE(MAX(sort_order), -1) AS top FROM editorial_banners");
    if (Number(count.total) >= MAX_BANNERS) throw httpError(`You can keep at most ${MAX_BANNERS} banners.`);
    sortOrder =
      fields.sortOrder === undefined || fields.sortOrder === ""
        ? Math.min(Number(count.top) + 1, MAX_SORT)
        : cleanSort(fields.sortOrder);
  } catch (error) {
    if (notReady(error)) throw httpError(NOT_READY_MESSAGE, 503);
    throw error;
  }

  const imageUrl = await uploadOrFail(files.image);
  const mobileImageUrl = files.mobileImage ? await uploadOrFail(files.mobileImage) : null;

  const id = randomUUID();
  try {
    await pool.execute(
      `
        INSERT INTO editorial_banners
          (id, name, image_url, mobile_image_url, link_url, active, sort_order, start_at, end_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [id, name, imageUrl, mobileImageUrl, linkUrl, active ? 1 : 0, sortOrder, startAt, endAt]
    );
  } catch (error) {
    await destroyIfUnused(pool, imageUrl);
    if (mobileImageUrl) await destroyIfUnused(pool, mobileImageUrl);
    throw error;
  }

  return toAdmin(await getOne(pool, id));
};

const update = async (id, fields, files = {}) => {
  requireId(id);
  const pool = await poolPromise;

  let existing;
  try {
    existing = await getOne(pool, id);
  } catch (error) {
    if (notReady(error)) throw httpError(NOT_READY_MESSAGE, 503);
    throw error;
  }
  if (!existing) throw httpError("Banner not found.", 404);

  const next = {
    name: fields.name === undefined ? existing.name : cleanName(fields.name),
    linkUrl: fields.linkUrl === undefined ? existing.link_url : cleanLink(fields.linkUrl),
    startAt:
      fields.startAt === undefined
        ? existing.start_at
          ? existing.start_at.slice(0, 19).replace("T", " ")
          : null
        : cleanDate("Start date", fields.startAt),
    endAt:
      fields.endAt === undefined
        ? existing.end_at
          ? existing.end_at.slice(0, 19).replace("T", " ")
          : null
        : cleanDate("End date", fields.endAt),
    active: fields.active === undefined ? Boolean(existing.active) : cleanActive(fields.active),
    sortOrder: fields.sortOrder === undefined ? Number(existing.sort_order) || 0 : cleanSort(fields.sortOrder),
  };
  checkWindow(next.startAt, next.endAt);

  let imageUrl = existing.image_url;
  let mobileImageUrl = existing.mobile_image_url || null;
  const replaced = [];

  if (files.image) {
    imageUrl = await uploadOrFail(files.image);
    replaced.push(existing.image_url);
  }
  if (files.mobileImage) {
    mobileImageUrl = await uploadOrFail(files.mobileImage);
    if (existing.mobile_image_url) replaced.push(existing.mobile_image_url);
  } else if (String(fields.removeMobileImage) === "true") {
    mobileImageUrl = null;
    if (existing.mobile_image_url) replaced.push(existing.mobile_image_url);
  }

  try {
    await pool.execute(
      `
        UPDATE editorial_banners
        SET name = ?, image_url = ?, mobile_image_url = ?, link_url = ?, active = ?,
            sort_order = ?, start_at = ?, end_at = ?
        WHERE id = ?
      `,
      [
        next.name,
        imageUrl,
        mobileImageUrl,
        next.linkUrl,
        next.active ? 1 : 0,
        next.sortOrder,
        next.startAt,
        next.endAt,
        id,
      ]
    );
  } catch (error) {
    if (files.image) await destroyIfUnused(pool, imageUrl);
    if (files.mobileImage) await destroyIfUnused(pool, mobileImageUrl);
    throw error;
  }

  for (const url of replaced) await destroyIfUnused(pool, url);

  return { before: toAdmin(existing), after: toAdmin(await getOne(pool, id)) };
};

const setActive = async (id, value) => {
  requireId(id);
  const active = cleanActive(value);
  const pool = await poolPromise;

  let existing;
  try {
    existing = await getOne(pool, id);
  } catch (error) {
    if (notReady(error)) throw httpError(NOT_READY_MESSAGE, 503);
    throw error;
  }
  if (!existing) throw httpError("Banner not found.", 404);

  await pool.execute("UPDATE editorial_banners SET active = ? WHERE id = ?", [active ? 1 : 0, id]);
  return { before: toAdmin(existing), after: toAdmin(await getOne(pool, id)) };
};

const remove = async (id) => {
  requireId(id);
  const pool = await poolPromise;

  let existing;
  try {
    existing = await getOne(pool, id);
  } catch (error) {
    if (notReady(error)) throw httpError(NOT_READY_MESSAGE, 503);
    throw error;
  }
  if (!existing) throw httpError("Banner not found.", 404);

  await pool.execute("DELETE FROM editorial_banners WHERE id = ?", [id]);
  await destroyIfUnused(pool, existing.image_url);
  if (existing.mobile_image_url) await destroyIfUnused(pool, existing.mobile_image_url);

  return toAdmin(existing);
};

module.exports = {
  listPublic,
  listAdmin,
  create,
  update,
  setActive,
  remove,
  // exported for tests
  bannerPublicId,
};
