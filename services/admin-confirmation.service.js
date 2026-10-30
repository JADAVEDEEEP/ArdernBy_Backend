const crypto = require("crypto");
const { poolPromise } = require("../config/sql");
const { getJwtSecret } = require("../config/jwt");
const { transporter, getBrevoSender } = require("../config/mailer");

// ==========================================
// FRESH CONFIRMATION FOR SENSITIVE ACCOUNT CHANGES
//
// Changing someone's role (or creating an Admin) needs two steps:
//   1. request  -> a random 6-digit code is e-mailed to the Super Admin who is
//                  asking (their own mailbox, not the target's)
//   2. confirm  -> the code, the confirmation id and the SAME change are sent
//                  back together
//
// The code is random (crypto.randomInt), never stored (only a keyed HMAC of
// it), expires in 10 minutes, allows 5 wrong guesses, is bound to one actor +
// one action + one target + one role, and can be used exactly once (the
// "mark used" UPDATE only succeeds for the first caller, so a replay or a
// double click is refused).
// ==========================================

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_REQUESTS_PER_HOUR = 6;
const REASON_MIN = 5;
const REASON_MAX = 500;

const httpError = (statusCode, message, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

const cleanReason = (value) => {
  const text =
    typeof value === "string"
      ? value
          .normalize("NFC")
          .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, REASON_MAX)
      : "";
  if (text.length < REASON_MIN) {
    throw httpError(400, `Please give a reason of at least ${REASON_MIN} characters.`);
  }
  return text;
};

const isMissingTable = (error) =>
  Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);

const hashCode = (id, code) =>
  crypto.createHmac("sha256", getJwtSecret()).update(`${id}:${code}`).digest("hex");

const safeEqualHex = (a, b) => {
  const left = Buffer.from(String(a), "hex");
  const right = Buffer.from(String(b), "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- e-mail -----------------------------------------------------------------

// Returns { ok, error } - never throws, never pretends a failed send worked.
const sendMail = async ({ to, subject, text }) => {
  try {
    const sender = getBrevoSender();
    await transporter.sendMail({
      from: sender.from,
      envelope: { from: sender.envelopeFrom, to },
      to,
      subject,
      text,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`,
    });
    return { ok: true };
  } catch (error) {
    console.error("Admin e-mail failed:", subject, "|", error.code || error.message);
    return { ok: false, error: "delivery_failed" };
  }
};

// ---- request ------------------------------------------------------------------

// summary: one human sentence describing the change, shown in the e-mail so the
// Super Admin can see exactly what the code will authorise.
const request = async ({ actor, action, targetId = null, targetEmail = null, newRole, reason, summary }) => {
  const text = cleanReason(reason);

  try {
    const pool = await poolPromise;

    const [recent] = await pool.execute(
      `
        SELECT COUNT(*) AS total FROM admin_confirmations
        WHERE actor_id = ? AND created_at >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 HOUR)
      `,
      [actor.id]
    );
    if (Number(recent[0]?.total || 0) >= MAX_REQUESTS_PER_HOUR) {
      throw httpError(429, "Too many confirmation requests. Please wait before trying again.");
    }

    const id = crypto.randomUUID();
    const code = String(crypto.randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000); // shown to the client only

    await pool.execute(
      `
        INSERT INTO admin_confirmations
          (id, action, actor_id, target_id, target_email, new_role, reason,
           code_hash, attempts, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0,
                DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${CODE_TTL_MINUTES} MINUTE), UTC_TIMESTAMP(6))
      `,
      [id, action, actor.id, targetId, targetEmail, newRole, text, hashCode(id, code)]
    );

    const mail = await sendMail({
      to: actor.email,
      subject: "KOVENIK admin confirmation code",
      text:
        `Your confirmation code is ${code}\n\n` +
        `It authorises ONE change: ${summary}\n` +
        `It expires in ${CODE_TTL_MINUTES} minutes and works once.\n\n` +
        `If you did not ask for this, do not share the code - someone may be using your account. Sign in and use "Sign out everywhere".`,
    });

    return {
      confirmationId: id,
      expiresAt: expiresAt.toISOString(),
      emailSent: mail.ok,
    };
  } catch (error) {
    if (isMissingTable(error)) {
      throw httpError(503, "Confirmation is not available yet. The database update has not been applied.");
    }
    throw error;
  }
};

// ---- consume --------------------------------------------------------------------

// Verifies and uses up a confirmation. Returns the stored reason.
const consume = async ({ id, code, actor, action, targetId = null, targetEmail = null, newRole }) => {
  if (typeof id !== "string" || id.length !== 36 || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw httpError(400, "A valid confirmation id and 6-digit code are required.", "CONFIRMATION_REQUIRED");
  }

  try {
    const pool = await poolPromise;
    const [rows] = await pool.execute(
      `
        SELECT id, action, actor_id, target_id, target_email, new_role, reason,
               code_hash, attempts, (expires_at > UTC_TIMESTAMP(6)) AS live, used_at
        FROM admin_confirmations WHERE id = ? LIMIT 1
      `,
      [id]
    );
    const row = rows[0];

    // One message for every failure, so nothing can be probed.
    const invalid = () => httpError(403, "The confirmation code is invalid or has expired.", "CONFIRMATION_INVALID");

    if (!row) throw invalid();
    if (row.actor_id !== actor.id) throw invalid();
    if (row.used_at) throw invalid();
    if (!Number(row.live)) throw invalid();
    if (Number(row.attempts) >= MAX_ATTEMPTS) throw invalid();

    // The code authorises exactly the change it was issued for.
    if (
      row.action !== action ||
      (row.target_id || null) !== (targetId || null) ||
      (row.target_email || null) !== (targetEmail || null) ||
      row.new_role !== newRole
    ) {
      throw invalid();
    }

    if (!safeEqualHex(hashCode(id, code), row.code_hash)) {
      await pool.execute("UPDATE admin_confirmations SET attempts = attempts + 1 WHERE id = ?", [id]);
      throw invalid();
    }

    // Single use: only the first caller flips used_at.
    const [used] = await pool.execute(
      `
        UPDATE admin_confirmations
        SET used_at = UTC_TIMESTAMP(6)
        WHERE id = ? AND used_at IS NULL AND attempts < ? AND expires_at > UTC_TIMESTAMP(6)
      `,
      [id, MAX_ATTEMPTS]
    );
    if (used.affectedRows !== 1) throw invalid();

    return { reason: row.reason };
  } catch (error) {
    if (isMissingTable(error)) {
      throw httpError(503, "Confirmation is not available yet. The database update has not been applied.");
    }
    throw error;
  }
};

// ---- notify all Super Admins ----------------------------------------------------

// Sends one e-mail per active Super Admin and reports honestly how many
// actually went out.
const notifySuperAdmins = async ({ subject, text }) => {
  let recipients = [];
  try {
    const pool = await poolPromise;
    const [rows] = await pool.execute(
      "SELECT email FROM profiles WHERE role = 'superadmin' AND is_active = 1"
    );
    recipients = rows.map((row) => row.email).filter(Boolean);
  } catch (error) {
    console.error("Could not list Super Admins to notify:", error.code || error.message);
    return { attempted: 0, delivered: 0, failed: 0, error: "recipients_unavailable" };
  }

  const results = await Promise.all(recipients.map((to) => sendMail({ to, subject, text })));
  const delivered = results.filter((r) => r.ok).length;
  return { attempted: recipients.length, delivered, failed: recipients.length - delivered };
};

module.exports = {
  request,
  consume,
  notifySuperAdmins,
  sendMail,
  cleanReason,
  CODE_TTL_MINUTES,
  MAX_ATTEMPTS,
};
