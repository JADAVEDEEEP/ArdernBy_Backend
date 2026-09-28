const { poolPromise } = require("../config/sql");

const bcrypt = require("bcryptjs");

// ==========================================
// GET USER BY ID
// ==========================================

const getUserById = async (userId) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        full_name,
        phone,
        email,
        gender,
        role,
        auth_provider,
        email_verified,
        is_active,
        created_at,
        updated_at
      FROM profiles
      WHERE id = ?
      LIMIT 1
    `,
    [userId]
  );

  if (rows.length === 0) {
    throw new Error("User not found.");
  }

  return rows[0];
};

// ==========================================
// UPDATE USER PROFILE
// ==========================================

const updateUserProfile = async ({
  userId,
  fullName,
  phone,
  gender,
}) => {
  const pool = await poolPromise;

  await pool.execute(
    `
      UPDATE profiles
      SET
        full_name = ?,
        phone = ?,
        gender = ?,
        updated_at = UTC_TIMESTAMP(6)
      WHERE id = ?
    `,
    [
      fullName || null,
      phone || null,
      gender || null,
      userId,
    ]
  );

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        full_name,
        phone,
        email,
        gender,
        role,
        auth_provider,
        email_verified,
        is_active,
        updated_at
      FROM profiles
      WHERE id = ?
      LIMIT 1
    `,
    [userId]
  );

  if (rows.length === 0) {
    throw new Error("User not found.");
  }

  return rows[0];
};

// ==========================================
// CHANGE PASSWORD
// ==========================================

const changePassword = async ({
  userId,
  currentPassword,
  newPassword,
}) => {
  const pool = await poolPromise;

  const [rows] = await pool.execute(
    `
      SELECT
        password_hash,
        auth_provider
      FROM profiles
      WHERE id = ?
        AND is_active = 1
      LIMIT 1
    `,
    [userId]
  );

  if (rows.length === 0) {
    throw new Error("User not found.");
  }

  const user = rows[0];

  if (!user.password_hash) {
    throw new Error(
      "Password is not configured for this account."
    );
  }

  const passwordMatch = await bcrypt.compare(
    currentPassword,
    user.password_hash
  );

  if (!passwordMatch) {
    throw new Error("Current password is incorrect.");
  }

  if (currentPassword === newPassword) {
    throw new Error(
      "New password must be different from current password."
    );
  }

  const newPasswordHash = await bcrypt.hash(
    newPassword,
    12
  );

  await pool.execute(
    `
      UPDATE profiles
      SET
        password_hash = ?,
        updated_at = UTC_TIMESTAMP(6)
      WHERE id = ?
    `,
    [
      newPasswordHash,
      userId,
    ]
  );

  return true;
};

// ==========================================
// DELETE ACCOUNT
// ==========================================

const deleteAccount = async ({ userId, password }) => {
  const pool = await poolPromise;

  // ==========================================
  // GET ACTIVE USER
  // ==========================================

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        email,
        password_hash,
        auth_provider
      FROM profiles
      WHERE id = ?
        AND is_active = 1
      LIMIT 1
    `,
    [userId]
  );

  if (rows.length === 0) {
    throw new Error("User not found.");
  }

  const user = rows[0];

  // ==========================================
  // EMAIL/PASSWORD ACCOUNT
  // ==========================================

  if (user.auth_provider === "email") {
    if (!password) {
      throw new Error("Password is required.");
    }

    if (!user.password_hash) {
      throw new Error(
        "Password is not configured for this account."
      );
    }

    const passwordMatch = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatch) {
      throw new Error("Password is incorrect.");
    }
  }

  // ==========================================
  // GOOGLE ACCOUNT
  // No password required.
  // ==========================================

  // ==========================================
  // DELETE ACCOUNT IDENTITY
  // Keep profile row for historical orders.
  // ==========================================

  await pool.execute(
    `
      UPDATE profiles
      SET
        full_name = NULL,
        phone = NULL,
        email = CONCAT(
          'deleted_',
          id,
          '@deleted.ardenby.local'
        ),
        password_hash = NULL,
        google_id = NULL,
        email_verified = 0,
        is_active = 0,
        updated_at = UTC_TIMESTAMP(6)
      WHERE id = ?
    `,
    [userId]
  );

  return true;
};

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  getUserById,
  updateUserProfile,
  changePassword,
  deleteAccount,
};