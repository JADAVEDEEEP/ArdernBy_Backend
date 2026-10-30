const { randomUUID } = require("crypto");
const { poolPromise } = require("../config/sql");
const { calculateCouponDiscount } = require("../utils/pricing");


// Validates and normalises admin coupon input (create and update). Existing
// stored coupons are never re-validated; this only guards new writes.
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,29}$/;

const validateCouponInput = (data, { requireCode = true } = {}) => {
  const fail = (message) => {
    throw new Error(message);
  };
  const input = data && typeof data === "object" ? data : {};

  let code;
  if (requireCode || input.code !== undefined) {
    code = String(input.code ?? "").trim().toUpperCase();
    if (!CODE_PATTERN.test(code)) {
      fail("Coupon code must be 3-30 characters: letters, numbers, hyphen or underscore.");
    }
  }

  const discountType = String(input.discount_type ?? "").toLowerCase();
  if (!["percentage", "flat"].includes(discountType)) {
    fail("Discount type must be percentage or flat.");
  }

  const value = Number(input.discount_value);
  if (!Number.isFinite(value) || value <= 0) fail("Discount value must be greater than 0.");
  if (discountType === "percentage" && value > 100) fail("A percentage discount cannot exceed 100.");

  const minOrder = input.min_order === undefined || input.min_order === "" ? 0 : Number(input.min_order);
  if (!Number.isFinite(minOrder) || minOrder < 0) fail("Minimum order must be 0 or more.");

  let maxDiscount = null;
  if (input.max_discount !== undefined && input.max_discount !== null && input.max_discount !== "") {
    maxDiscount = Number(input.max_discount);
    if (!Number.isFinite(maxDiscount) || maxDiscount <= 0) fail("Maximum discount must be greater than 0.");
  }

  const expiryDate = new Date(input.expiry);
  if (!input.expiry || Number.isNaN(expiryDate.getTime())) fail("A valid expiry date is required.");

  const description =
    input.description === undefined || input.description === null || input.description === ""
      ? null
      : String(input.description).trim().slice(0, 255) || null;

  return {
    code,
    description,
    discount_type: discountType,
    discount_value: value,
    min_order: minOrder,
    max_discount: discountType === "percentage" ? maxDiscount : null,
    // Stored exactly as sent (a date-time without zone), as before.
    expiry: input.expiry,
    active: input.active === undefined ? true : Boolean(input.active),
  };
};

const createCoupon = async (rawData) => {
  const data = validateCouponInput(rawData);
  const {
    code,
    description = null,
    discount_type,
    discount_value,
    min_order = 0,
    max_discount = null,
    expiry,
    active = true,
  } = data;

  if (
    !code ||
    !discount_type ||
    discount_value === undefined ||
    !expiry
  ) {
    throw new Error("Required coupon fields are missing.");
  }

  const pool = await poolPromise;

  const normalizedCode = code.trim().toUpperCase();

  // Check duplicate coupon code
  const [existingRows] = await pool.execute(
    `
      SELECT id
      FROM coupons
      WHERE code = ?
      LIMIT 1
    `,
    [normalizedCode]
  );

  if (existingRows.length > 0) {
    throw new Error("Coupon code already exists.");
  }

  const id = randomUUID();

  // Insert coupon
  await pool.execute(
    `
      INSERT INTO coupons
      (
        id,
        code,
        description,
        discount_type,
        discount_value,
        min_order,
        max_discount,
        expiry,
        active,
        created_at
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
        UTC_TIMESTAMP(6)
      )
    `,
    [
      id,
      normalizedCode,
      description,
      discount_type,
      discount_value,
      min_order,
      max_discount === null ? null : max_discount,
      expiry,
      active ? 1 : 0,
    ]
  );

  // Return inserted coupon
  const [rows] = await pool.execute(
    `
      SELECT *
      FROM coupons
      WHERE id = ?
      LIMIT 1
    `,
    [id]
  );

  return rows[0];
};

const getCoupons = async () => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT *
      FROM coupons
      ORDER BY created_at DESC
    `
  );

  return rows;
};

const getCouponByCode = async (code) => {
  if (!code) {
    throw new Error("Coupon code is required.");
  }

  const pool = await poolPromise;

  const normalizedCode = code.trim().toUpperCase();

  const [rows] = await pool.execute(
    `
      SELECT *
      FROM coupons
      WHERE code = ?
      LIMIT 1
    `,
    [normalizedCode]
  );

  if (rows.length === 0) {
    throw new Error("Coupon not found.");
  }

  return rows[0];
};

const updateCoupon = async (id, rawData) => {
  const data = validateCouponInput(rawData, { requireCode: false });
  const {
    description,
    discount_type,
    discount_value,
    min_order,
    max_discount,
    expiry,
    active,
  } = data;

  const pool = await poolPromise;

  const [result] = await pool.execute(
    `
      UPDATE coupons
      SET
        description = ?,
        discount_type = ?,
        discount_value = ?,
        min_order = ?,
        max_discount = ?,
        expiry = ?,
        active = ?
      WHERE id = ?
    `,
    [
      description,
      discount_type,
      discount_value,
      min_order,
      max_discount === null ? null : max_discount,
      expiry,
      active ? 1 : 0,
      id,
    ]
  );

  if (result.affectedRows === 0) {
    throw new Error("Coupon not found.");
  }

  // Return updated coupon
  const [rows] = await pool.execute(
    `
      SELECT *
      FROM coupons
      WHERE id = ?
      LIMIT 1
    `,
    [id]
  );

  return rows[0];
};

const deleteCoupon = async (id) => {
  const pool = await poolPromise;

  // Fetch first because MySQL doesn't support
  // SQL Server's OUTPUT DELETED.*
  const [rows] = await pool.execute(
    `
      SELECT *
      FROM coupons
      WHERE id = ?
      LIMIT 1
    `,
    [id]
  );

  if (rows.length === 0) {
    throw new Error("Coupon not found.");
  }

  const deletedCoupon = rows[0];

  await pool.execute(
    `
      DELETE FROM coupons
      WHERE id = ?
    `,
    [id]
  );

  return deletedCoupon;
};

const validateCoupon = async (code, subtotal) => {
  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    throw new Error("A valid cart subtotal is required.");
  }

  const coupon = await getCouponByCode(code);

  const now = new Date();

  if (!coupon.active) {
    throw new Error("Coupon is inactive.");
  }

  if (new Date(coupon.expiry) < now) {
    throw new Error("Coupon has expired.");
  }

  if (subtotal < Number(coupon.min_order)) {
    throw new Error(
      `Minimum order value is ₹${coupon.min_order}.`
    );
  }

  const discount = calculateCouponDiscount(coupon, subtotal);

  return {
    coupon,
    subtotal,
    discount,
    total: subtotal - discount,
  };
};
const getAvailableCoupons = async () => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(`
    SELECT
      id,
      code,
      description,
      discount_type,
      discount_value,
      min_order,
      max_discount,
      expiry,
      active
    FROM coupons
    WHERE active = 1
      AND expiry >= UTC_TIMESTAMP()
    ORDER BY expiry ASC
  `);

  return rows;
};
module.exports = {
  createCoupon,
  getCoupons,
  getCouponByCode,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
  getAvailableCoupons,
};