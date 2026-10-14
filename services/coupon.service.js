const { randomUUID } = require("crypto");
const { poolPromise } = require("../config/sql");

const createCoupon = async (data) => {
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

const updateCoupon = async (id, data) => {
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

  let discount = 0;

  if (coupon.discount_type === "percentage") {
    discount =
      (subtotal * Number(coupon.discount_value)) / 100;

    if (
      coupon.max_discount !== null &&
      discount > Number(coupon.max_discount)
    ) {
      discount = Number(coupon.max_discount);
    }
  } else if (coupon.discount_type === "flat") {
    discount = Number(coupon.discount_value);
  } else {
    throw new Error("Invalid discount type.");
  }

  if (discount > subtotal) {
    discount = subtotal;
  }

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