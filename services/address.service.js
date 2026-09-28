const { randomUUID } = require("crypto");
const { poolPromise } = require("../config/sql");

// ==========================================
// GET ALL ADDRESSES
// ==========================================

const getAddresses = async (userId) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        name,
        phone,
        pincode,
        address,
        city,
        state,
        address_type,
        is_default,
        created_at,
        updated_at
      FROM addresses
      WHERE user_id = ?
      ORDER BY is_default DESC, created_at DESC
    `,
    [userId]
  );

  return rows;
};

// ==========================================
// GET ADDRESS BY ID
// ==========================================

const getAddressById = async (userId, addressId) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        name,
        phone,
        pincode,
        address,
        city,
        state,
        address_type,
        is_default,
        created_at,
        updated_at
      FROM addresses
      WHERE
        id = ?
        AND user_id = ?
      LIMIT 1
    `,
    [addressId, userId]
  );

  if (rows.length === 0) {
    throw new Error("Address not found.");
  }

  return rows[0];
};

// ==========================================
// CREATE ADDRESS
// ==========================================

const createAddress = async (
  userId,
  {
    name,
    phone,
    pincode,
    address,
    city,
    state,
    addressType,
    isDefault = false,
  }
) => {
  const pool = await poolPromise;

  // If new address is default,
  // remove default from existing addresses
  if (isDefault) {
    await pool.execute(
      `
        UPDATE addresses
        SET
          is_default = 0,
          updated_at = UTC_TIMESTAMP(6)
        WHERE user_id = ?
      `,
      [userId]
    );
  }

  // Generate ID in JavaScript
  const addressId = randomUUID();

  await pool.execute(
    `
      INSERT INTO addresses
      (
        id,
        user_id,
        name,
        phone,
        pincode,
        address,
        city,
        state,
        address_type,
        is_default,
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
        UTC_TIMESTAMP(6),
        UTC_TIMESTAMP(6)
      )
    `,
    [
      addressId,
      userId,
      name,
      phone,
      pincode,
      address,
      city,
      state,
      addressType,
      isDefault ? 1 : 0,
    ]
  );

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        name,
        phone,
        pincode,
        address,
        city,
        state,
        address_type,
        is_default,
        created_at,
        updated_at
      FROM addresses
      WHERE
        id = ?
        AND user_id = ?
      LIMIT 1
    `,
    [addressId, userId]
  );

  return rows[0];
};

// ==========================================
// UPDATE ADDRESS
// ==========================================

const updateAddress = async (
  userId,
  addressId,
  {
    name,
    phone,
    pincode,
    address,
    city,
    state,
    addressType,
    isDefault,
  }
) => {
  const pool = await poolPromise;

  // Check address belongs to user
  const [existingRows] = await pool.execute(
    `
      SELECT id
      FROM addresses
      WHERE
        id = ?
        AND user_id = ?
      LIMIT 1
    `,
    [addressId, userId]
  );

  if (existingRows.length === 0) {
    throw new Error("Address not found.");
  }

  // If updated address becomes default,
  // remove default from other addresses
  if (isDefault === true) {
    await pool.execute(
      `
        UPDATE addresses
        SET
          is_default = 0,
          updated_at = UTC_TIMESTAMP(6)
        WHERE user_id = ?
      `,
      [userId]
    );
  }

  await pool.execute(
    `
      UPDATE addresses
      SET
        name = ?,
        phone = ?,
        pincode = ?,
        address = ?,
        city = ?,
        state = ?,
        address_type = ?,
        is_default = ?,
        updated_at = UTC_TIMESTAMP(6)
      WHERE
        id = ?
        AND user_id = ?
    `,
    [
      name,
      phone,
      pincode,
      address,
      city,
      state,
      addressType,
      isDefault ? 1 : 0,
      addressId,
      userId,
    ]
  );

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        name,
        phone,
        pincode,
        address,
        city,
        state,
        address_type,
        is_default,
        created_at,
        updated_at
      FROM addresses
      WHERE
        id = ?
        AND user_id = ?
      LIMIT 1
    `,
    [addressId, userId]
  );

  return rows[0];
};

// ==========================================
// DELETE ADDRESS
// ==========================================

const deleteAddress = async (userId, addressId) => {
  const pool = await poolPromise;

  // Check address belongs to user
  const [existingRows] = await pool.execute(
    `
      SELECT id
      FROM addresses
      WHERE
        id = ?
        AND user_id = ?
      LIMIT 1
    `,
    [addressId, userId]
  );

  if (existingRows.length === 0) {
    throw new Error("Address not found.");
  }

  await pool.execute(
    `
      DELETE FROM addresses
      WHERE
        id = ?
        AND user_id = ?
    `,
    [addressId, userId]
  );

  return {
    id: addressId,
    user_id: userId,
  };
};

// ==========================================
// SET DEFAULT ADDRESS
// ==========================================

const setDefaultAddress = async (
  userId,
  addressId
) => {
  const pool = await poolPromise;

  // Check address belongs to user
  const [existingRows] = await pool.execute(
    `
      SELECT id
      FROM addresses
      WHERE
        id = ?
        AND user_id = ?
      LIMIT 1
    `,
    [addressId, userId]
  );

  if (existingRows.length === 0) {
    throw new Error("Address not found.");
  }

  // Remove default from all user's addresses
  await pool.execute(
    `
      UPDATE addresses
      SET
        is_default = 0,
        updated_at = UTC_TIMESTAMP(6)
      WHERE user_id = ?
    `,
    [userId]
  );

  // Set selected address as default
  await pool.execute(
    `
      UPDATE addresses
      SET
        is_default = 1,
        updated_at = UTC_TIMESTAMP(6)
      WHERE
        id = ?
        AND user_id = ?
    `,
    [addressId, userId]
  );

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        name,
        phone,
        pincode,
        address,
        city,
        state,
        address_type,
        is_default,
        created_at,
        updated_at
      FROM addresses
      WHERE
        id = ?
        AND user_id = ?
      LIMIT 1
    `,
    [addressId, userId]
  );

  return rows[0];
};

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  getAddresses,
  getAddressById,
  createAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
};