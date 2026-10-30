const { randomUUID } = require("crypto");
const { poolPromise } = require("../config/sql");

// ==========================================
// AUDIT TRAIL
//
// Append-only table `audit_logs` (scripts/sql/admin_controls_phase1.sql). This
// module only ever INSERTs and SELECTs: there is deliberately no update or
// delete function, and no route exposes one. (That is application-level
// protection; scripts/sql/audit_logs_protect.sql adds optional database
// triggers. Neither makes the log tamper-proof against someone who controls
// the database itself.)
//
// record() never throws: an audit problem must not undo a business change that
// already succeeded. It does NOT fail silently either - every failed write is
// logged loudly with the action and resource so it can be investigated.
// ==========================================

const MAX_JSON_BYTES = 8000;
const SECRET_KEY = /pass(word)?|token|secret|hash|^otp$|confirmation_?code|authorization|cookie|api_?key/i;

const httpError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

// The table comes from scripts/sql/admin_controls_phase1.sql. Until it is applied, say so
// plainly instead of returning a generic server error.
const notInstalled = (error) =>
  Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);

// Drops anything that looks like a credential, so a careless caller can never
// write a password or token into the log. Depth and size are bounded.
const scrub = (value, depth = 0) => {
  if (value === null || value === undefined) return null;
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = scrub(inner, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return value.slice(0, 500);
  return value;
};

const toJson = (value) => {
  if (value === undefined || value === null) return null;
  const text = JSON.stringify(scrub(value));
  if (text === undefined) return null;
  if (text.length > MAX_JSON_BYTES) {
    return JSON.stringify({ truncated: true, note: "value too large to store" });
  }
  return text;
};

const actorFrom = (req) => ({
  id: req?.user?.id || null,
  email: req?.user?.email || null,
  role: req?.user?.role || null,
  ip: (req?.ip || req?.socket?.remoteAddress || "").toString().slice(0, 64) || null,
});

// entry: { actor | req, action, resourceType, resourceId, outcome, reason,
//          before, after, dedupeKey }
// dedupeKey: when the same logical operation is retried it must produce the
// same key; the second insert is then ignored instead of duplicated.
const record = async (entry) => {
  const actor = entry.actor || actorFrom(entry.req);

  try {
    const pool = await poolPromise;
    const [result] = await pool.execute(
      `
        INSERT IGNORE INTO audit_logs
          (id, created_at, actor_id, actor_email, actor_role, action,
           resource_type, resource_id, outcome, reason, before_value,
           after_value, ip, dedupe_key)
        VALUES (?, UTC_TIMESTAMP(6), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        actor.id,
        actor.email ? String(actor.email).slice(0, 254) : null,
        actor.role,
        String(entry.action).slice(0, 64),
        String(entry.resourceType).slice(0, 40),
        entry.resourceId == null ? null : String(entry.resourceId).slice(0, 100),
        entry.outcome === "failure" ? "failure" : "success",
        entry.reason ? String(entry.reason).slice(0, 500) : null,
        toJson(entry.before),
        toJson(entry.after),
        actor.ip,
        entry.dedupeKey ? String(entry.dedupeKey).slice(0, 190) : null,
      ]
    );
    return Boolean(result && result.affectedRows !== 0);
  } catch (error) {
    console.error(
      "AUDIT WRITE FAILED | action:",
      entry.action,
      "| resource:",
      entry.resourceType,
      entry.resourceId ?? "-",
      "|",
      error.code || error.message
    );
    return false;
  }
};

// ---- reading ---------------------------------------------------------------

const parseJson = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const toIso = (value) => (value instanceof Date ? value.toISOString() : value ? String(value) : null);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const list = async ({ page, limit, action, actor, resourceType, outcome, from, to } = {}) => {
  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const pageNumber = Math.max(parseInt(page, 10) || 1, 1);

  const where = [];
  const params = [];

  const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

  if (text(action, 64)) {
    where.push("action = ?");
    params.push(text(action, 64));
  }
  if (text(resourceType, 40)) {
    where.push("resource_type = ?");
    params.push(text(resourceType, 40));
  }
  if (outcome === "success" || outcome === "failure") {
    where.push("outcome = ?");
    params.push(outcome);
  }
  if (text(actor, 100)) {
    where.push("(actor_id = ? OR actor_email LIKE ?)");
    params.push(text(actor, 100), `%${text(actor, 100).replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (from) {
    if (!DATE_RE.test(from)) throw httpError("from must be YYYY-MM-DD.");
    where.push("created_at >= ?");
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    if (!DATE_RE.test(to)) throw httpError("to must be YYYY-MM-DD.");
    where.push("created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(`${to} 00:00:00`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const pool = await poolPromise;

  let countRow;
  let rows;
  try {
    [[countRow], [rows]] = await Promise.all([
      pool.execute(`SELECT COUNT(*) AS total FROM audit_logs ${whereSql}`, params),
      pool.execute(
        `
          SELECT id, DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at, actor_id, actor_email, actor_role, action,
                 resource_type, resource_id, outcome, reason, before_value,
                 after_value, ip
          FROM audit_logs
          ${whereSql}
          ORDER BY created_at DESC, id DESC
          LIMIT ${pageSize} OFFSET ${(pageNumber - 1) * pageSize}
        `,
        params
      ),
    ]);
  } catch (error) {
    if (notInstalled(error)) {
      throw httpError("The audit log is not available yet. The database update has not been applied.", 503);
    }
    throw error;
  }

  const total = Number(countRow[0]?.total || 0);

  return {
    logs: rows.map((row) => ({
      id: row.id,
      createdAt: toIso(row.created_at),
      actorId: row.actor_id,
      actorEmail: row.actor_email,
      actorRole: row.actor_role,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      outcome: row.outcome,
      reason: row.reason,
      before: parseJson(row.before_value),
      after: parseJson(row.after_value),
      ip: row.ip,
    })),
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    },
  };
};

// Reads one row for a before-value. Only these tables/columns can be asked for
// (fixed names, never request data), so this cannot be steered into other data.
const SNAPSHOT_TARGETS = {
  coupons: "id",
  categories: "slug",
};

const snapshotRow = async (table, id) => {
  const column = SNAPSHOT_TARGETS[table];
  if (!column || id === undefined || id === null) return null;

  try {
    const pool = await poolPromise;
    const [rows] = await pool.execute(
      `SELECT * FROM ${table} WHERE ${column} = ? LIMIT 1`,
      [String(id)]
    );
    return rows[0] || null;
  } catch (error) {
    console.error("Audit snapshot failed:", table, error.code || error.message);
    return null;
  }
};

module.exports = { record, list, actorFrom, scrub, snapshotRow };
