const { randomUUID } = require("crypto");
const { poolPromise } = require("../config/sql");

// ==========================================
// COORDINATE COLUMNS (latitude / longitude)
// ==========================================
// The columns are added by scripts/sql/address_coordinates_phase1.sql. Until that migration has been applied,
// the service behaves exactly as before (coordinates are not read or written), so this code can be deployed
// before or after the migration without breaking address loading. A positive answer is cached for good; a
// negative one is re-checked every minute so applying the migration needs no restart.

const BASE_COLUMNS = [
  "id",
  "user_id",
  "name",
  "phone",
  "pincode",
  "address",
  "city",
  "state",
  "address_type",
  "is_default",
  "created_at",
  "updated_at",
];

let coordinateSupport = { known: null, checkedAt: 0 };
const RECHECK_MS = 60 * 1000;

const hasCoordinateColumns = async (pool) => {
  if (coordinateSupport.known === true) return true;
  if (coordinateSupport.known === false && Date.now() - coordinateSupport.checkedAt < RECHECK_MS) return false;

  let found = false;
  try {
    const [rows] = await pool.execute(
      `
        SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE
          TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'addresses'
          AND COLUMN_NAME IN ('latitude', 'longitude')
      `
    );
    found = Array.isArray(rows) && rows.length === 2;
  } catch (error) {
    // Fail safe: if the check itself cannot run, behave as if the columns do not exist.
    console.error("Address coordinate column check failed:", error.message);
  }

  coordinateSupport = { known: found, checkedAt: Date.now() };
  return found;
};

const selectList = (withCoordinates) =>
  (withCoordinates ? [...BASE_COLUMNS, "latitude", "longitude"] : BASE_COLUMNS).join(", ");

// DECIMAL columns come back from mysql2 as strings ("23.0855700"); the API returns numbers or null.
const shape = (row) => {
  if (!row) return row;
  const toNumber = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  return { ...row, latitude: toNumber(row.latitude), longitude: toNumber(row.longitude) };
};

// Returns undefined when the caller sent no coordinates (leave the stored ones alone),
// { latitude: null, longitude: null } to clear them, or the validated pair.
const normalizeCoordinates = (latitude, longitude) => {
  if (latitude === undefined && longitude === undefined) return undefined;

  const empty = (v) => v === null || v === undefined || v === "";
  if (empty(latitude) && empty(longitude)) return { latitude: null, longitude: null };

  const lat = typeof latitude === "number" || typeof latitude === "string" ? Number(latitude) : NaN;
  const lng = typeof longitude === "number" || typeof longitude === "string" ? Number(longitude) : NaN;

  if (empty(latitude) || empty(longitude) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("Latitude and longitude must both be valid numbers.");
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error("Latitude must be between -90 and 90 and longitude between -180 and 180.");
  }

  // 7 decimal places is what DECIMAL(10,7) stores (about 1 cm).
  return { latitude: Number(lat.toFixed(7)), longitude: Number(lng.toFixed(7)) };
};

// ==========================================
// GET ALL ADDRESSES
// ==========================================

const getAddresses = async (userId) => {
  const pool = await poolPromise;
  const withCoordinates = await hasCoordinateColumns(pool);

  const [rows] = await pool.execute(
    `
      SELECT ${selectList(withCoordinates)}
      FROM addresses
      WHERE user_id = ?
      ORDER BY is_default DESC, created_at DESC
    `,
    [userId]
  );

  return rows.map(shape);
};

// ==========================================
// GET ADDRESS BY ID
// ==========================================

const getAddressById = async (userId, addressId) => {
  const pool = await poolPromise;
  const withCoordinates = await hasCoordinateColumns(pool);

  const [rows] = await pool.execute(
    `
      SELECT ${selectList(withCoordinates)}
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

  return shape(rows[0]);
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
    latitude,
    longitude,
  }
) => {
  // Validate before anything is written.
  const coordinates = normalizeCoordinates(latitude, longitude);

  const pool = await poolPromise;
  const withCoordinates = await hasCoordinateColumns(pool);

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

  const columns = [
    "id",
    "user_id",
    "name",
    "phone",
    "pincode",
    "address",
    "city",
    "state",
    "address_type",
    "is_default",
  ];
  const values = [
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
  ];

  if (withCoordinates && coordinates) {
    columns.push("latitude", "longitude");
    values.push(coordinates.latitude, coordinates.longitude);
  }

  await pool.execute(
    `
      INSERT INTO addresses
      (${columns.join(", ")}, created_at, updated_at)
      VALUES
      (${columns.map(() => "?").join(", ")}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
    `,
    values
  );

  const [rows] = await pool.execute(
    `
      SELECT ${selectList(withCoordinates)}
      FROM addresses
      WHERE
        id = ?
        AND user_id = ?
      LIMIT 1
    `,
    [addressId, userId]
  );

  return shape(rows[0]);
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
    latitude,
    longitude,
  }
) => {
  // Validate before anything is written.
  const coordinates = normalizeCoordinates(latitude, longitude);

  const pool = await poolPromise;
  const withCoordinates = await hasCoordinateColumns(pool);

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

  const assignments = [
    "name = ?",
    "phone = ?",
    "pincode = ?",
    "address = ?",
    "city = ?",
    "state = ?",
    "address_type = ?",
    "is_default = ?",
  ];
  const values = [
    name,
    phone,
    pincode,
    address,
    city,
    state,
    addressType,
    isDefault ? 1 : 0,
  ];

  // Only touch the coordinates when the request carried them; an edit that sends none keeps the saved pin.
  if (withCoordinates && coordinates) {
    assignments.push("latitude = ?", "longitude = ?");
    values.push(coordinates.latitude, coordinates.longitude);
  }

  await pool.execute(
    `
      UPDATE addresses
      SET
        ${assignments.join(",\n        ")},
        updated_at = UTC_TIMESTAMP(6)
      WHERE
        id = ?
        AND user_id = ?
    `,
    [...values, addressId, userId]
  );

  const [rows] = await pool.execute(
    `
      SELECT ${selectList(withCoordinates)}
      FROM addresses
      WHERE
        id = ?
        AND user_id = ?
      LIMIT 1
    `,
    [addressId, userId]
  );

  return shape(rows[0]);
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
  const withCoordinates = await hasCoordinateColumns(pool);

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
      SELECT ${selectList(withCoordinates)}
      FROM addresses
      WHERE
        id = ?
        AND user_id = ?
      LIMIT 1
    `,
    [addressId, userId]
  );

  return shape(rows[0]);
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
  // exported for tests
  normalizeCoordinates,
};
