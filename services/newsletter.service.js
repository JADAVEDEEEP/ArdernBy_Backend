const crypto = require("crypto");
const { poolPromise } = require("../config/sql");

// ==========================================
// NEWSLETTER SUBSCRIPTIONS (double opt-in)
//
//   subscribe -> a PENDING row + a single-use confirmation token (only its SHA-256 hash is stored)
//             -> a branded confirmation e-mail through the existing Brevo setup
//   confirm   -> the token is spent and the subscriber becomes ACTIVE, in ONE atomic statement
//
// Only `active` subscribers may ever receive marketing. A pending address has not proven it owns
// the mailbox, and an unsubscribed address stays suppressed until its owner confirms again.
//
// subscribe() answers the same way whether or not the address is already known, so the form cannot
// be used to find out who is subscribed.
// ==========================================

const CONFIRM_TTL_HOURS = 48;
const RESEND_AFTER_MINUTES = 60;
// Bump when the wording shown next to the Join button changes (stored with each consent).
const CONSENT_TEXT_VERSION = "v1";
const SOURCES = new Set(["home", "footer"]);

const httpError = (statusCode, message, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

const isMissingTable = (error) => Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);
const notAvailable = () =>
  httpError(503, "Newsletter sign-up is not available right now. Please try again later.", "NEWSLETTER_NOT_AVAILABLE");

// Practical RFC 5322 subset: ASCII, one @, dotted labels, no leading/trailing/double dots.
const EMAIL =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const normalizeEmail = (value) => {
  if (typeof value !== "string") return "";
  const email = value.normalize("NFC").trim().toLowerCase();
  if (email.length > 254 || email.length < 6) return "";
  const [local] = email.split("@");
  if (!local || local.length > 64) return "";
  return EMAIL.test(email) ? email : "";
};

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
// 256 bits of CSPRNG output, URL-safe (43 characters).
const newToken = () => crypto.randomBytes(32).toString("base64url");
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

// A keyed hash of the consenting IP: proves "who consented" to an auditor without keeping the IP.
const hashIp = (ip) => {
  const secret = process.env.NEWSLETTER_HASH_SECRET || process.env.JWT_SECRET;
  if (!secret || !ip) return null;
  return crypto.createHmac("sha256", secret).update(String(ip)).digest("hex");
};

const cleanAgent = (value) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 255) || null : null;

const defaultDeliver = (args) => require("./notification.service").deliver(args);
const confirmUrl = (token) => require("./email/layout").link.newsletterConfirm(token);

const GENERIC_OK = "Almost there! Check your inbox for a confirmation email to finish joining.";

const subscribe = async (input = {}, context = {}, deps = {}) => {
  const email = normalizeEmail(input.email);
  if (!email) throw httpError(400, "Please enter a valid email address.", "EMAIL_INVALID");

  const source = SOURCES.has(input.source) ? input.source : "home";
  const deliver = deps.deliver || defaultDeliver;

  try {
    const pool = deps.pool || (await poolPromise);

    let [rows] = await pool.execute("SELECT id, status FROM newsletter_subscribers WHERE email = ? LIMIT 1", [email]);
    let subscriber = rows[0];

    if (!subscriber) {
      await pool.execute(
        `INSERT IGNORE INTO newsletter_subscribers
           (email, status, source, consent_text_version, consent_ip_hash, consent_user_agent,
            subscribed_at, created_at, updated_at)
         VALUES (?, 'pending', ?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [email, source, CONSENT_TEXT_VERSION, hashIp(context.ip), cleanAgent(context.userAgent)]
      );
      // INSERT IGNORE: a parallel request may have won the race; read whichever row exists.
      [rows] = await pool.execute("SELECT id, status FROM newsletter_subscribers WHERE email = ? LIMIT 1", [email]);
      subscriber = rows[0];
    }
    if (!subscriber) throw notAvailable();

    // Already confirmed: nothing to send, and the answer looks the same.
    if (subscriber.status === "active") return { message: GENERIC_OK };

    // Claim the right to send (once per hour per address). Concurrent requests cannot both win.
    const [claim] = await pool.execute(
      `UPDATE newsletter_subscribers
          SET confirmation_sent_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
        WHERE id = ? AND status <> 'active'
          AND (confirmation_sent_at IS NULL
               OR confirmation_sent_at < UTC_TIMESTAMP(6) - INTERVAL ${RESEND_AFTER_MINUTES} MINUTE)`,
      [subscriber.id]
    );
    if (claim.affectedRows !== 1) return { message: GENERIC_OK };

    // One live confirmation link at a time: older unused ones stop working.
    await pool.execute(
      "UPDATE newsletter_tokens SET used_at = UTC_TIMESTAMP(6) WHERE subscriber_id = ? AND purpose = 'confirm' AND used_at IS NULL",
      [subscriber.id]
    );
    const token = newToken();
    await pool.execute(
      `INSERT INTO newsletter_tokens (subscriber_id, purpose, token_hash, expires_at, created_at)
       VALUES (?, 'confirm', ?, UTC_TIMESTAMP(6) + INTERVAL ${CONFIRM_TTL_HOURS} HOUR, UTC_TIMESTAMP(6))`,
      [subscriber.id, sha256(token)]
    );

    try {
      await deliver({ to: email, template: "newsletter_confirm", data: { confirmUrl: confirmUrl(token), hours: CONFIRM_TTL_HOURS } });
    } catch (error) {
      console.error("Newsletter confirmation e-mail failed:", error.code || error.message);
      // Let the visitor try again straight away, and kill the link that was never delivered.
      await pool
        .execute("UPDATE newsletter_tokens SET used_at = UTC_TIMESTAMP(6) WHERE token_hash = ?", [sha256(token)])
        .catch(() => {});
      await pool
        .execute("UPDATE newsletter_subscribers SET confirmation_sent_at = NULL WHERE id = ?", [subscriber.id])
        .catch(() => {});
      throw httpError(503, "We could not send the confirmation email. Please try again in a moment.", "EMAIL_SEND_FAILED");
    }

    return { message: GENERIC_OK };
  } catch (error) {
    if (isMissingTable(error)) throw notAvailable();
    throw error;
  }
};

// Spends the token and activates the subscriber in ONE statement: both happen or neither does,
// and two clicks at the same moment cannot both succeed.
const confirm = async (token, deps = {}) => {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) {
    throw httpError(400, "This confirmation link is not valid.", "TOKEN_INVALID");
  }
  const tokenHash = sha256(token);

  try {
    const pool = deps.pool || (await poolPromise);

    const [result] = await pool.execute(
      `UPDATE newsletter_tokens t
         JOIN newsletter_subscribers s ON s.id = t.subscriber_id
          SET t.used_at = UTC_TIMESTAMP(6),
              s.status = 'active',
              s.confirmed_at = UTC_TIMESTAMP(6),
              s.unsubscribed_at = NULL,
              s.updated_at = UTC_TIMESTAMP(6)
        WHERE t.token_hash = ? AND t.purpose = 'confirm'
          AND t.used_at IS NULL AND t.expires_at > UTC_TIMESTAMP(6)
          AND s.status IN ('pending', 'unsubscribed')`,
      [tokenHash]
    );
    if (result.affectedRows > 0) return { message: "Your email is confirmed. Welcome to the inner circle." };

    // Not activated: say why, without revealing anything about other subscribers.
    const [rows] = await pool.execute(
      `SELECT t.used_at, t.expires_at <= UTC_TIMESTAMP(6) AS expired, s.status
         FROM newsletter_tokens t JOIN newsletter_subscribers s ON s.id = t.subscriber_id
        WHERE t.token_hash = ? AND t.purpose = 'confirm' LIMIT 1`,
      [tokenHash]
    );
    const row = rows[0];
    if (row && row.status === "active") {
      return { message: "Your email is already confirmed. You're on the list.", alreadyConfirmed: true };
    }
    if (row && !row.used_at && Number(row.expired) === 1) {
      throw httpError(410, "This confirmation link has expired. Please sign up again to get a new one.", "TOKEN_EXPIRED");
    }
    throw httpError(400, "This confirmation link is not valid or has already been used.", "TOKEN_INVALID");
  } catch (error) {
    if (isMissingTable(error)) throw notAvailable();
    throw error;
  }
};

// ---------------------------------------------------------------------------------
// UNSUBSCRIBE
//
// Every marketing e-mail carries its OWN unsubscribe token (buildUnsubscribe). A token is
// single-use: spending it flips the subscriber to `unsubscribed` and marks the token used, in one
// atomic statement. A second click, or a different old e-mail's link, still ends in "you are
// unsubscribed" (never an error that might make someone think it failed), but a link can never
// switch anything back ON: only confirm() can re-activate an address.
// ---------------------------------------------------------------------------------

const unsubscribe = async (token, deps = {}) => {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) {
    throw httpError(400, "This unsubscribe link is not valid.", "TOKEN_INVALID");
  }
  const tokenHash = sha256(token);

  try {
    const pool = deps.pool || (await poolPromise);

    const [result] = await pool.execute(
      `UPDATE newsletter_tokens t
         JOIN newsletter_subscribers s ON s.id = t.subscriber_id
          SET t.used_at = UTC_TIMESTAMP(6),
              s.status = 'unsubscribed',
              s.unsubscribed_at = UTC_TIMESTAMP(6),
              s.updated_at = UTC_TIMESTAMP(6)
        WHERE t.token_hash = ? AND t.purpose = 'unsubscribe'
          AND t.used_at IS NULL
          AND s.status IN ('active', 'pending')`,
      [tokenHash]
    );
    if (result.affectedRows > 0) return { message: "You have been unsubscribed. You will not receive any more emails from us." };

    const [rows] = await pool.execute(
      `SELECT s.status
         FROM newsletter_tokens t JOIN newsletter_subscribers s ON s.id = t.subscriber_id
        WHERE t.token_hash = ? AND t.purpose = 'unsubscribe' LIMIT 1`,
      [tokenHash]
    );
    if (rows[0] && rows[0].status === "unsubscribed") {
      return { message: "You are already unsubscribed. You will not receive any more emails from us.", alreadyUnsubscribed: true };
    }
    throw httpError(400, "This unsubscribe link is not valid.", "TOKEN_INVALID");
  } catch (error) {
    if (isMissingTable(error)) throw notAvailable();
    throw error;
  }
};

// Issues a fresh unsubscribe token for ONE recipient of ONE e-mail and returns everything the
// sender needs: the visible footer link and the RFC 8058 one-click headers. (Used by campaign
// sending in a later phase; nothing sends marketing e-mail yet.)
const buildUnsubscribe = async (subscriberId, deps = {}) => {
  const pool = deps.pool || (await poolPromise);
  const layout = require("./email/layout");
  const token = newToken();
  await pool.execute(
    `INSERT INTO newsletter_tokens (subscriber_id, purpose, token_hash, expires_at, created_at)
     VALUES (?, 'unsubscribe', ?, NULL, UTC_TIMESTAMP(6))`,
    [subscriberId, sha256(token)]
  );
  const oneClickUrl = layout.link.newsletterOneClick(token);
  return {
    token,
    url: layout.link.newsletterUnsubscribe(token),
    oneClickUrl,
    headers: {
      "List-Unsubscribe": `<${oneClickUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
};

// THE single gate for marketing recipients: only confirmed (`active`) subscribers, never pending,
// unsubscribed, bounced or complained. Campaign sending must read recipients ONLY through this,
// so an unsubscribed address cannot be mailed. Keyset-paged by id.
//
// Optional audience narrowing (it can only ever REMOVE people, never add): `ids` (a chosen list) and
// `source` (where they signed up). The status check always stays in the WHERE clause.
const audienceClause = ({ ids, source } = {}) => {
  let sql = "";
  const params = [];
  if (Array.isArray(ids)) {
    const strict = (x) => (typeof x === "number" ? x : typeof x === "string" && /^d{1,18}$/.test(x) ? Number(x) : NaN);
    const list = [...new Set(ids.map(strict).filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, 5000);
    if (list.length === 0) return { sql: " AND 1 = 0", params: [] };
    sql += ` AND id IN (${list.map(() => "?").join(",")})`;
    params.push(...list);
  }
  if (typeof source === "string" && source) {
    sql += " AND source = ?";
    params.push(source);
  }
  return { sql, params };
};

const listSendable = async ({ afterId = 0, limit = 500, ids, source } = {}, deps = {}) => {
  const pool = deps.pool || (await poolPromise);
  const size = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);
  const after = Math.max(parseInt(afterId, 10) || 0, 0);
  const extra = audienceClause({ ids, source });
  const [rows] = await pool.execute(
    `SELECT id, email FROM newsletter_subscribers
      WHERE status = 'active' AND id > ?${extra.sql}
      ORDER BY id ASC LIMIT ${size}`,
    [after, ...extra.params]
  );
  return rows;
};

// How many people listSendable would return for an audience (same status gate).
const countSendable = async ({ ids, source } = {}, deps = {}) => {
  const pool = deps.pool || (await poolPromise);
  const extra = audienceClause({ ids, source });
  const [[row]] = await pool.execute(
    `SELECT COUNT(*) AS c FROM newsletter_subscribers WHERE status = 'active'${extra.sql}`,
    extra.params
  );
  return Number(row.c);
};

module.exports = {
  subscribe,
  confirm,
  unsubscribe,
  buildUnsubscribe,
  listSendable,
  countSendable,
  TOKEN_SHAPE,
  normalizeEmail,
  hashIp,
  sha256,
  CONFIRM_TTL_HOURS,
  CONSENT_TEXT_VERSION,
};
