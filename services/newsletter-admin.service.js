const { poolPromise } = require("../config/sql");
const audit = require("./audit.service");
const { csvLine, startCsv, write } = require("./export.service");

// ==========================================
// NEWSLETTER MANAGEMENT (admin + super admin)
//
// Reads the existing newsletter_subscribers table. The ONLY change an admin can make is to
// UNSUBSCRIBE a subscriber (never to activate or re-activate one). Nothing here sends an email. The API never returns the consent IP hash or user agent: an admin needs the address, the
// status and the dates, nothing more.
// ==========================================

const STATUSES = ["pending", "active", "unsubscribed"];
const PAGE = 500;

const httpError = (statusCode, message, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

const isMissingTable = (error) => Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);
const guard = (error) => {
  if (isMissingTable(error)) {
    throw httpError(503, "The newsletter tables are not available yet. The database update has not been applied.", "NEWSLETTER_NOT_AVAILABLE");
  }
  throw error;
};

// UTC timestamps as unambiguous ISO strings (the pool applies no time zone of its own).
const iso = (column) => `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%sZ')`;

const stats = async (deps = {}) => {
  try {
    const pool = deps.pool || (await poolPromise);
    const [rows] = await pool.execute("SELECT status, COUNT(*) AS c FROM newsletter_subscribers GROUP BY status");
    const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
    return {
      total: Object.values(by).reduce((a, b) => a + b, 0),
      active: by.active || 0,
      pending: by.pending || 0,
      unsubscribed: by.unsubscribed || 0,
    };
  } catch (error) {
    return guard(error);
  }
};

// Escapes LIKE wildcards so "a_b%" searches for those characters, not a pattern.
const likeTerm = (value) => `%${value.replace(/[|%_]/g, (c) => `|${c}`)}%`;

const filtersOf = ({ status, search }) => {
  const where = [];
  const params = [];

  const wantedStatus = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (wantedStatus) {
    if (!STATUSES.includes(wantedStatus)) throw httpError(400, "Unknown status filter.", "STATUS_INVALID");
    where.push("status = ?");
    params.push(wantedStatus);
  }

  const term = typeof search === "string" ? search.normalize("NFC").trim().toLowerCase().slice(0, 100) : "";
  if (term) {
    where.push("email LIKE ? ESCAPE '|'");
    params.push(likeTerm(term));
  }
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
};

const list = async ({ page, limit, status, search } = {}, deps = {}) => {
  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
  const { where, params } = filtersOf({ status, search });

  try {
    const pool = deps.pool || (await poolPromise);
    const [[count]] = await pool.execute(`SELECT COUNT(*) AS c FROM newsletter_subscribers ${where}`, params);
    const total = Number(count.c);
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);

    const [rows] = await pool.execute(
      `SELECT id, email, status, source,
              ${iso("subscribed_at")} AS subscribed_at,
              ${iso("confirmed_at")} AS confirmed_at,
              ${iso("unsubscribed_at")} AS unsubscribed_at
         FROM newsletter_subscribers
         ${where}
        ORDER BY id DESC
        LIMIT ${pageSize} OFFSET ${(pageNumber - 1) * pageSize}`,
      params
    );

    return {
      subscribers: rows.map((r) => ({
        id: String(r.id),
        email: r.email,
        status: r.status,
        source: r.source,
        subscribedAt: r.subscribed_at,
        confirmedAt: r.confirmed_at,
        unsubscribedAt: r.unsubscribed_at,
      })),
      pagination: { page: pageNumber, limit: pageSize, total, totalPages },
    };
  } catch (error) {
    return guard(error);
  }
};

const COLUMNS = ["email", "subscribed_at_utc", "confirmed_at_utc", "source"];

// Streams the ACTIVE (confirmed) subscribers as CSV, in id-ordered pages so memory stays flat.
// Pending and unsubscribed addresses are never exported. The export is written to the audit trail.
const streamActiveCsv = async ({ res, actor }, deps = {}) => {
  const pool = deps.pool || (await poolPromise);
  const filename = `kovenik-newsletter-subscribers_${new Date().toISOString().slice(0, 10)}.csv`;

  let written = 0;
  let failure = null;
  let started = false;

  try {
    // Probe first so a missing table is a normal JSON error, not a broken download.
    await pool.execute("SELECT 1 FROM newsletter_subscribers LIMIT 1");
    await startCsv(res, filename);
    started = true;
    await write(res, csvLine(COLUMNS));

    let afterId = 0;
    for (;;) {
      const [rows] = await pool.execute(
        `SELECT id, email, source,
                ${iso("subscribed_at")} AS subscribed_at,
                ${iso("confirmed_at")} AS confirmed_at
           FROM newsletter_subscribers
          WHERE status = 'active' AND id > ?
          ORDER BY id ASC LIMIT ${PAGE}`,
        [afterId]
      );
      if (rows.length === 0) break;

      let chunk = "";
      for (const row of rows) chunk += csvLine([row.email, row.subscribed_at, row.confirmed_at, row.source]);
      await write(res, chunk);
      written += rows.length;
      afterId = rows[rows.length - 1].id;
      if (rows.length < PAGE) break;
    }
    res.end();
  } catch (error) {
    failure = error;
    if (!started) return guard(error);
    res.destroy();
  } finally {
    if (started || failure) {
      await audit.record({
        actor,
        action: "export.newsletter",
        resourceType: "export",
        resourceId: filename,
        outcome: failure ? "failure" : "success",
        reason: failure ? String(failure.message).slice(0, 200) : null,
        after: { rows: written, status: "active" },
      });
    }
  }
};

// ---- manual unsubscribe -----------------------------------------------------------------

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MIN_REASON = 5;

// An admin unsubscribes someone who asked to be removed (support email, complaint). The only
// transition this code can write is  active|pending -> unsubscribed.  There is deliberately no
// code path that sets 'active': only the subscriber's own double opt-in confirmation can do that.
// It needs explicit confirmation (confirm === true) and a written reason, and is audited. The audit
// entry carries the numeric subscriber id and the status change only, never the email address.
const adminUnsubscribe = async ({ id, reason, confirm, actor } = {}, deps = {}) => {
  if (confirm !== true) {
    throw httpError(400, "Please confirm that you want to unsubscribe this subscriber.", "CONFIRM_REQUIRED");
  }
  const subscriberId = typeof id === "string" && /^\d{1,18}$/.test(id) ? id : null;
  if (!subscriberId) throw httpError(404, "Subscriber not found.", "NOT_FOUND");

  const text = typeof reason === "string" ? reason.normalize("NFC").replace(CONTROL, "").trim() : "";
  if (text.length < MIN_REASON) {
    throw httpError(400, `Please give a reason of at least ${MIN_REASON} characters.`, "REASON_REQUIRED");
  }
  if (text.length > 500) throw httpError(400, "The reason is too long (500 characters at most).", "REASON_TOO_LONG");

  try {
    const pool = deps.pool || (await poolPromise);
    const record = deps.audit || audit.record;

    const [rows] = await pool.execute("SELECT id, status FROM newsletter_subscribers WHERE id = ? LIMIT 1", [subscriberId]);
    const subscriber = rows[0];
    if (!subscriber) throw httpError(404, "Subscriber not found.", "NOT_FOUND");
    if (subscriber.status === "unsubscribed") return { changed: false, alreadyUnsubscribed: true, status: "unsubscribed" };

    // The WHERE clause is the safety net: a concurrent change cannot be overwritten, and a
    // status other than active / pending (for example a future 'bounced') is left alone.
    const [result] = await pool.execute(
      `UPDATE newsletter_subscribers
          SET status = 'unsubscribed', unsubscribed_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
        WHERE id = ? AND status IN ('active', 'pending')`,
      [subscriberId]
    );
    // 0 rows: the status is not one an admin may change (or changed a moment ago). Nothing was written.
    if (result.affectedRows !== 1) return { changed: false, alreadyUnsubscribed: subscriber.status === "unsubscribed", status: subscriber.status };

    // Kill any confirmation link still in the person's inbox, so a stale link cannot quietly
    // turn the address back on after an admin removed it.
    await pool.execute(
      "UPDATE newsletter_tokens SET used_at = UTC_TIMESTAMP(6) WHERE subscriber_id = ? AND purpose = 'confirm' AND used_at IS NULL",
      [subscriberId]
    );

    await record({
      actor,
      action: "newsletter.unsubscribe",
      resourceType: "newsletter_subscriber",
      resourceId: subscriberId,
      reason: text,
      before: { status: subscriber.status },
      after: { status: "unsubscribed" },
    });

    return { changed: true, alreadyUnsubscribed: false, status: "unsubscribed" };
  } catch (error) {
    return guard(error);
  }
};

// ---- subscriber-list access log --------------------------------------------------------

const VIEW_LOG_WINDOW_MS = 10 * 60 * 1000;
const lastViewLogged = new Map();

// Viewing the list shows personal data, so the access is recorded, but sparingly: at most one entry
// per admin per 10 minutes (paging and typing in the search box would otherwise flood the audit
// log). It stores the filter KIND only: which status was chosen, whether a search was used and the
// page. It never stores the search text (which may itself be an email address) or any subscriber.
const recordListView = async ({ actor, status, search, page, total } = {}, deps = {}) => {
  const key = actor?.id || "unknown";
  const now = (deps.now || Date.now)();
  const last = lastViewLogged.get(key);
  if (last !== undefined && now - last < VIEW_LOG_WINDOW_MS) return false;
  lastViewLogged.set(key, now);

  const wanted = String(status || "").toLowerCase();
  await (deps.audit || audit.record)({
    actor,
    action: "newsletter.view_list",
    resourceType: "newsletter",
    after: {
      status: STATUSES.includes(wanted) ? wanted : "all",
      searched: Boolean(search && String(search).trim()),
      page: Math.max(parseInt(page, 10) || 1, 1),
      matching: Number.isFinite(total) ? total : null,
    },
  });
  return true;
};

module.exports = { stats, list, streamActiveCsv, adminUnsubscribe, recordListView, STATUSES, VIEW_LOG_WINDOW_MS };
