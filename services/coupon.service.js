const { randomUUID } = require("crypto");
const { sql, poolPromise } = require("../config/sql");

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

  const existing = await pool
    .request()
    .input("code", sql.NVarChar(100), code.trim().toUpperCase())
    .query(`
      SELECT id
      FROM dbo.coupons
      WHERE code = @code
    `);

  if (existing.recordset.length > 0) {
    throw new Error("Coupon code already exists.");
  }

  const id = randomUUID();

const result = await pool
  .request()
  .input("id", sql.NVarChar(100), id)
  .input("code", sql.NVarChar(100), code.trim().toUpperCase())
  .input("description", sql.NVarChar(sql.MAX), description)
  .input("discount_type", sql.NVarChar(20), discount_type)
  .input("discount_value", sql.Decimal(10, 2), discount_value)
  .input("min_order", sql.Decimal(10, 2), min_order)
  .input(
    "max_discount",
    sql.Decimal(10, 2),
    max_discount === null ? null : max_discount
  )
  .input("expiry", sql.DateTime2, expiry)
  .input("active", sql.Bit, active)
  .query(`
    INSERT INTO dbo.coupons
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
    OUTPUT INSERTED.*
    VALUES
    (
      @id,
      @code,
      @description,
      @discount_type,
      @discount_value,
      @min_order,
      @max_discount,
      @expiry,
      @active,
      GETDATE()
    )
  `);
  return result.recordset[0];
};


const getCoupons = async () => {
  const pool = await poolPromise;

  const result = await pool.request().query(`
    SELECT *
    FROM dbo.coupons
    ORDER BY created_at DESC
  `);

  return result.recordset;
};


const getCouponByCode = async (code) => {
  if (!code) {
    throw new Error("Coupon code is required.");
  }

  const pool = await poolPromise;

  const result = await pool
    .request()
    .input("code", sql.NVarChar(100), code.trim().toUpperCase())
    .query(`
      SELECT *
      FROM dbo.coupons
      WHERE code = @code
    `);

  if (result.recordset.length === 0) {
    throw new Error("Coupon not found.");
  }

  return result.recordset[0];
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

  const result = await pool
    .request()
  .input("id", sql.NVarChar(100), id)
    .input("description", sql.NVarChar(sql.MAX), description)
    .input("discount_type", sql.NVarChar(20), discount_type)
    .input("discount_value", sql.Decimal(10, 2), discount_value)
    .input("min_order", sql.Decimal(10, 2), min_order)
    .input(
      "max_discount",
      sql.Decimal(10, 2),
      max_discount === null ? null : max_discount
    )
    .input("expiry", sql.DateTime2, expiry)
    .input("active", sql.Bit, active)
    .query(`
      UPDATE dbo.coupons
      SET
        description = @description,
        discount_type = @discount_type,
        discount_value = @discount_value,
        min_order = @min_order,
        max_discount = @max_discount,
        expiry = @expiry,
        active = @active
      OUTPUT INSERTED.*
      WHERE id = @id
    `);

  if (result.recordset.length === 0) {
    throw new Error("Coupon not found.");
  }

  return result.recordset[0];
};


const deleteCoupon = async (id) => {
  const pool = await poolPromise;

  const result = await pool
    .request()
   .input("id", sql.NVarChar(100), id)
    .query(`
      DELETE FROM dbo.coupons
      OUTPUT DELETED.*
      WHERE id = @id
    `);

  if (result.recordset.length === 0) {
    throw new Error("Coupon not found.");
  }

  return result.recordset[0];
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


module.exports = {
  createCoupon,
  getCoupons,
  getCouponByCode,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
};