const { sql, poolPromise } = require("../config/sql");

// ==========================================
// GET ALL ADDRESSES
// ==========================================

const getAddresses = async (userId) => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
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
      WHERE user_id = @userId
      ORDER BY is_default DESC, created_at DESC
    `);

  return result.recordset;
};

// ==========================================
// GET ADDRESS BY ID
// ==========================================

const getAddressById = async (userId, addressId) => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("addressId", sql.UniqueIdentifier, addressId)
    .query(`
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
        id = @addressId
        AND user_id = @userId
    `);

  if (result.recordset.length === 0) {
    throw new Error("Address not found.");
  }

  return result.recordset[0];
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
    await pool
      .request()
      .input("userId", sql.UniqueIdentifier, userId)
      .query(`
        UPDATE addresses
        SET
          is_default = 0,
          updated_at = SYSUTCDATETIME()
        WHERE user_id = @userId
      `);
  }

  // Generate ID in JavaScript
  const addressId = crypto.randomUUID();

  await pool
    .request()
    .input(
      "addressId",
      sql.UniqueIdentifier,
      addressId
    )
    .input("userId", sql.UniqueIdentifier, userId)
    .input("name", sql.NVarChar, name)
    .input("phone", sql.NVarChar, phone)
    .input("pincode", sql.NVarChar, pincode)
    .input("address", sql.NVarChar, address)
    .input("city", sql.NVarChar, city)
    .input("state", sql.NVarChar, state)
    .input("addressType", sql.NVarChar, addressType)
    .input("isDefault", sql.Bit, isDefault)
    .query(`
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
        @addressId,
        @userId,
        @name,
        @phone,
        @pincode,
        @address,
        @city,
        @state,
        @addressType,
        @isDefault,
        SYSUTCDATETIME(),
        SYSUTCDATETIME()
      )
    `);

  const result = await pool
    .request()
    .input(
      "addressId",
      sql.UniqueIdentifier,
      addressId
    )
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
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
        id = @addressId
        AND user_id = @userId
    `);

  return result.recordset[0];
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
  const existingResult = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("addressId", sql.UniqueIdentifier, addressId)
    .query(`
      SELECT TOP 1
        id
      FROM addresses
      WHERE
        id = @addressId
        AND user_id = @userId
    `);

  if (existingResult.recordset.length === 0) {
    throw new Error("Address not found.");
  }

  // If updated address becomes default,
  // remove default from other addresses
  if (isDefault === true) {
    await pool
      .request()
      .input("userId", sql.UniqueIdentifier, userId)
      .query(`
        UPDATE addresses
        SET
          is_default = 0,
          updated_at = SYSUTCDATETIME()
        WHERE user_id = @userId
      `);
  }

  await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("addressId", sql.UniqueIdentifier, addressId)
    .input("name", sql.NVarChar, name)
    .input("phone", sql.NVarChar, phone)
    .input("pincode", sql.NVarChar, pincode)
    .input("address", sql.NVarChar, address)
    .input("city", sql.NVarChar, city)
    .input("state", sql.NVarChar, state)
    .input("addressType", sql.NVarChar, addressType)
    .input("isDefault", sql.Bit, isDefault)
    .query(`
      UPDATE addresses
      SET
        name = @name,
        phone = @phone,
        pincode = @pincode,
        address = @address,
        city = @city,
        state = @state,
        address_type = @addressType,
        is_default = @isDefault,
        updated_at = SYSUTCDATETIME()
      WHERE
        id = @addressId
        AND user_id = @userId
    `);

  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("addressId", sql.UniqueIdentifier, addressId)
    .query(`
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
        id = @addressId
        AND user_id = @userId
    `);

  return result.recordset[0];
};

// ==========================================
// DELETE ADDRESS
// ==========================================

const deleteAddress = async (userId, addressId) => {
  const pool = await poolPromise;

  // Check address belongs to user
  const existingResult = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("addressId", sql.UniqueIdentifier, addressId)
    .query(`
      SELECT TOP 1
        id
      FROM addresses
      WHERE
        id = @addressId
        AND user_id = @userId
    `);

  if (existingResult.recordset.length === 0) {
    throw new Error("Address not found.");
  }

  await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("addressId", sql.UniqueIdentifier, addressId)
    .query(`
      DELETE FROM addresses
      WHERE
        id = @addressId
        AND user_id = @userId
    `);

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
  const existingResult = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("addressId", sql.UniqueIdentifier, addressId)
    .query(`
      SELECT TOP 1
        id
      FROM addresses
      WHERE
        id = @addressId
        AND user_id = @userId
    `);

  if (existingResult.recordset.length === 0) {
    throw new Error("Address not found.");
  }

  // Remove default from all user's addresses
  await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      UPDATE addresses
      SET
        is_default = 0,
        updated_at = SYSUTCDATETIME()
      WHERE user_id = @userId
    `);

  // Set selected address as default
  await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("addressId", sql.UniqueIdentifier, addressId)
    .query(`
      UPDATE addresses
      SET
        is_default = 1,
        updated_at = SYSUTCDATETIME()
      WHERE
        id = @addressId
        AND user_id = @userId
    `);

  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("addressId", sql.UniqueIdentifier, addressId)
    .query(`
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
        id = @addressId
        AND user_id = @userId
    `);

  return result.recordset[0];
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