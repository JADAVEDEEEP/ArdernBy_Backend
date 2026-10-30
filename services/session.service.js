const { randomUUID } = require("crypto");
const { poolPromise } = require("../config/sql");

// ==========================================
// SESSIONS: revocation and login history
//
// The login system is unchanged: a signed token plus a database re-check on
// every request (role and active flag). This module adds two things on top:
//
// * session_revocations: "every token issued at or before this moment is
//   dead". Written by sign-out-everywhere and whenever an account is
//   deactivated or its role changes, so a token minted before the change can
//   never come back to life if the account is later re-enabled or re-promoted.
//   It is checked on Admin / Super Admin requests only (customers are not
//   affected and pay no extra query).
// * login_history: when and from where an Admin / Super Admin signed in.
//
// Token times are whole seconds, so a token issued in the same second as the
// revocation is also revoked; signing in again a second later works.
// ==========================================

const PRIVILEGED = new Set(["admin", "superadmin"]);

const isMissingTable = (error) =>
  Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);

let warned = false;

// true when the token must be refused. If the table is not installed yet the
// feature is simply off (existing behaviour); any other database error is
// thrown so the caller fails closed (503) instead of letting a token through.
const isRevoked = async (userId, issuedAtSeconds) => {
  try {
    const pool = await poolPromise;
    const [rows] = await pool.execute(
      "SELECT revoked_before FROM session_revocations WHERE user_id = ? LIMIT 1",
      [userId]
    );
    if (!rows[0]) return false;
    // A token without an issue time cannot be proven newer: refuse it.
    if (!Number.isFinite(Number(issuedAtSeconds))) return true;
    return Number(issuedAtSeconds) <= Number(rows[0].revoked_before);
  } catch (error) {
    if (isMissingTable(error)) {
      if (!warned) {
        warned = true;
        console.warn("Session revocation is off (apply admin_controls_phase1.sql).");
      }
      return false;
    }
    throw error;
  }
};

const revokeAll = async (userId, executor = null) => {
  const pool = executor || (await poolPromise);
  const now = Math.floor(Date.now() / 1000);
  try {
    await pool.execute(
      `
        INSERT INTO session_revocations (user_id, revoked_before, updated_at)
        VALUES (?, ?, UTC_TIMESTAMP(6))
        ON DUPLICATE KEY UPDATE revoked_before = VALUES(revoked_before), updated_at = VALUES(updated_at)
      `,
      [userId, now]
    );
    return { revoked: true, at: now };
  } catch (error) {
    console.error("SESSION REVOCATION FAILED | user:", userId, "|", error.code || error.message);
    return { revoked: false, at: null, error: isMissingTable(error) ? "not_installed" : "failed" };
  }
};

const recordLogin = async ({ user, method, req }) => {
  if (!user || !PRIVILEGED.has(user.role)) return false;
  try {
    const pool = await poolPromise;
    await pool.execute(
      `
        INSERT INTO login_history (id, user_id, method, ip, user_agent, created_at)
        VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))
      `,
      [
        randomUUID(),
        user.id,
        method,
        (req?.ip || "").toString().slice(0, 64) || null,
        String(req?.headers?.["user-agent"] || "").slice(0, 255) || null,
      ]
    );
    return true;
  } catch (error) {
    if (!isMissingTable(error)) {
      console.error("LOGIN HISTORY WRITE FAILED | user:", user.id, "|", error.code || error.message);
    }
    return false;
  }
};

const listLogins = async (userId, limit = 20) => {
  const size = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  try {
    const pool = await poolPromise;
    const [rows] = await pool.execute(
      `
        SELECT id, method, ip, user_agent,
               DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
        FROM login_history
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ${size}
      `,
      [userId]
    );
    return {
      available: true,
      logins: rows.map((row) => ({
        id: row.id,
        method: row.method,
        ip: row.ip,
        userAgent: row.user_agent,
        at: String(row.created_at),
      })),
    };
  } catch (error) {
    if (isMissingTable(error)) return { available: false, logins: [] };
    throw error;
  }
};

module.exports = { PRIVILEGED, isRevoked, revokeAll, recordLogin, listLogins };
