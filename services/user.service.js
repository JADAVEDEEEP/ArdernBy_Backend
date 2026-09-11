const { sql, poolPromise } = require("../config/sql");

const bcrypt = require("bcryptjs");

// ==========================================
// GET USER BY ID
// ==========================================

const getUserById = async (userId) => {
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
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
      FROM dbo.profiles
      WHERE id = @userId
    `);

  if (result.recordset.length === 0) {
    throw new Error("User not found.");
  }

  return result.recordset[0];
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

  await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input("fullName", sql.VarChar(150), fullName || null)
    .input("phone", sql.VarChar(30), phone || null)
    .input("gender", sql.VarChar(20), gender || null)
    .query(`
      UPDATE dbo.profiles
      SET
        full_name = @fullName,
        phone = @phone,
        gender = @gender,
        updated_at = SYSUTCDATETIME()
      WHERE id = @userId;
    `);

  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
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
      FROM dbo.profiles
      WHERE id = @userId;
    `);

  if (result.recordset.length === 0) {
    throw new Error("User not found.");
  }

  return result.recordset[0];
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

  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      SELECT
        password_hash,
        auth_provider
      FROM dbo.profiles
      WHERE id = @userId
        AND is_active = 1
    `);

  if (result.recordset.length === 0) {
    throw new Error("User not found.");
  }

  const user = result.recordset[0];

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

  await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .input(
      "passwordHash",
      sql.VarChar(255),
      newPasswordHash
    )
    .query(`
      UPDATE dbo.profiles
      SET
        password_hash = @passwordHash,
        updated_at = SYSUTCDATETIME()
      WHERE id = @userId
    `);

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

  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      SELECT
        id,
        email,
        password_hash,
        auth_provider
      FROM dbo.profiles
      WHERE id = @userId
        AND is_active = 1
    `);

  if (result.recordset.length === 0) {
    throw new Error("User not found.");
  }

  const user = result.recordset[0];

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

  await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      UPDATE dbo.profiles
      SET
        full_name = NULL,
        phone = NULL,

        email = CONCAT(
          'deleted_',
          CONVERT(varchar(36), id),
          '@deleted.ardenby.local'
        ),

        password_hash = NULL,
        google_id = NULL,
        email_verified = 0,
        is_active = 0,

        updated_at = SYSUTCDATETIME()

      WHERE id = @userId;
    `);

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