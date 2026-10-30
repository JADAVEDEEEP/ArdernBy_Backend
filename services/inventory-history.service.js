const { randomUUID } = require("crypto");
const { poolPromise } = require("../config/sql");

// ==========================================
// INVENTORY HISTORY
//
// A ledger (`inventory_movements`) written next to every stock change. The
// stock numbers themselves still live in product_variants / products exactly as
// before; this module only records what happened. Writing history never makes
// the stock change fail: a ledger problem is logged loudly and the order /
// cancellation / edit goes on (stock correctness matters more than the log).
//
// `executor` is the pool or, inside a transaction, the connection - so the
// history row commits or rolls back together with the stock change.
//
// A dedupeKey makes a retried operation produce the same key; the unique index
// then ignores the second row instead of duplicating it.
// ==========================================

const httpError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

// The table comes from scripts/sql/admin_controls_phase1.sql. Until it is applied, say so
// plainly instead of returning a generic server error.
const notInstalled = (error) =>
  Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);

const logFailure = (context, error) =>
  console.error("INVENTORY HISTORY WRITE FAILED |", context, "|", error.code || error.message);

const record = async (
  executor,
  {
    productId,
    variantId = null,
    previous,
    next,
    reason,
    source,
    referenceType = null,
    referenceId = null,
    actorId = null,
    dedupeKey = null,
  }
) => {
  try {
    const prev = Number(previous);
    const now = Number(next);
    if (!productId || !Number.isFinite(prev) || !Number.isFinite(now) || prev === now) {
      return false;
    }

    const [result] = await executor.execute(
      `
        INSERT IGNORE INTO inventory_movements
          (id, created_at, product_id, variant_id, previous_qty, new_qty, delta,
           reason, source, reference_type, reference_id, actor_id, dedupe_key)
        VALUES (?, UTC_TIMESTAMP(6), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        String(productId),
        variantId ? String(variantId) : null,
        prev,
        now,
        now - prev,
        String(reason).slice(0, 200),
        String(source).slice(0, 30),
        referenceType,
        referenceId ? String(referenceId).slice(0, 64) : null,
        actorId,
        dedupeKey ? String(dedupeKey).slice(0, 190) : null,
      ]
    );
    return Boolean(result && result.affectedRows !== 0);
  } catch (error) {
    logFailure(`${source} ${variantId || productId}`, error);
    return false;
  }
};

// For code that has just applied "inventory = inventory +/- n" to one variant:
// reads the resulting quantity and records the step. Call it AFTER the update,
// on the same connection.
const recordVariantDelta = async (
  executor,
  { variantId, delta, reason, source, referenceType, referenceId, actorId, dedupeKey }
) => {
  try {
    const [rows] = await executor.execute(
      "SELECT product_id, inventory FROM product_variants WHERE id = ? LIMIT 1",
      [variantId]
    );
    if (!rows[0]) return false;

    const next = Number(rows[0].inventory);
    return await record(executor, {
      productId: rows[0].product_id,
      variantId,
      previous: next - Number(delta),
      next,
      reason,
      source,
      referenceType,
      referenceId,
      actorId,
      dedupeKey,
    });
  } catch (error) {
    logFailure(`${source} ${variantId}`, error);
    return false;
  }
};

// ---- reading ---------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = [
  "admin_edit",
  "initial_stock",
  "order_placed",
  "order_paid",
  "order_cancelled",
  "return_received",
];

const list = async ({ page, limit, productId, variantId, source, from, to, search } = {}) => {
  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const pageNumber = Math.max(parseInt(page, 10) || 1, 1);

  const where = [];
  const params = [];
  const pool = await poolPromise;

  if (typeof productId === "string" && productId.trim()) {
    where.push("m.product_id = ?");
    params.push(productId.trim().slice(0, 64));
  }
  if (typeof variantId === "string" && variantId.trim()) {
    where.push("m.variant_id = ?");
    params.push(variantId.trim().slice(0, 64));
  }
  if (typeof source === "string" && source) {
    if (!SOURCES.includes(source)) throw httpError("Unknown source.");
    where.push("m.source = ?");
    params.push(source);
  }
  if (from) {
    if (!DATE_RE.test(from)) throw httpError("from must be YYYY-MM-DD.");
    where.push("m.created_at >= ?");
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    if (!DATE_RE.test(to)) throw httpError("to must be YYYY-MM-DD.");
    where.push("m.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(`${to} 00:00:00`);
  }

  // Product-name search is resolved first, then applied as an id list, so the
  // ledger table is never joined to the product table by text columns.
  if (typeof search === "string" && search.trim()) {
    const like = `%${search.trim().slice(0, 100).replace(/[\\%_]/g, "\\$&")}%`;
    const [matches] = await pool.execute(
      "SELECT id FROM products WHERE name LIKE ? OR slug LIKE ? LIMIT 200",
      [like, like]
    );
    if (matches.length === 0) {
      return {
        movements: [],
        pagination: { page: pageNumber, limit: pageSize, total: 0, totalPages: 1 },
      };
    }
    where.push(`m.product_id IN (${matches.map(() => "?").join(", ")})`);
    params.push(...matches.map((row) => String(row.id)));
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  let countRow;
  let rows;
  try {
    [[countRow], [rows]] = await Promise.all([
      pool.execute(`SELECT COUNT(*) AS total FROM inventory_movements m ${whereSql}`, params),
      pool.execute(
        `
          SELECT m.id, DATE_FORMAT(m.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at, m.product_id, m.variant_id, m.previous_qty,
                 m.new_qty, m.delta, m.reason, m.source, m.reference_type,
                 m.reference_id, m.actor_id
          FROM inventory_movements m
          ${whereSql}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT ${pageSize} OFFSET ${(pageNumber - 1) * pageSize}
        `,
        params
      ),
    ]);
  } catch (error) {
    if (notInstalled(error)) {
      throw httpError("Stock history is not available yet. The database update has not been applied.", 503);
    }
    throw error;
  }

  const productIds = [...new Set(rows.map((row) => row.product_id))];
  const variantIds = [...new Set(rows.map((row) => row.variant_id).filter(Boolean))];
  const actorIds = [...new Set(rows.map((row) => row.actor_id).filter(Boolean))];

  const lookup = async (sql, ids) => {
    if (ids.length === 0) return [];
    const [found] = await pool.execute(sql.replace("(?)", `(${ids.map(() => "?").join(", ")})`), ids);
    return found;
  };

  const [products, variants, actors] = await Promise.all([
    lookup("SELECT id, name FROM products WHERE id IN (?)", productIds),
    lookup("SELECT id, size, color FROM product_variants WHERE id IN (?)", variantIds),
    lookup("SELECT id, full_name, email FROM profiles WHERE id IN (?)", actorIds),
  ]);

  const productName = new Map(products.map((row) => [String(row.id), row.name]));
  const variantLabel = new Map(
    variants.map((row) => [String(row.id), [row.size, row.color].filter(Boolean).join(" / ")])
  );
  const actorName = new Map(actors.map((row) => [String(row.id), row.full_name || row.email]));

  const total = Number(countRow[0]?.total || 0);

  return {
    movements: rows.map((row) => ({
      id: row.id,
      createdAt: String(row.created_at),
      productId: row.product_id,
      productName: productName.get(String(row.product_id)) || null,
      variantId: row.variant_id,
      variant: row.variant_id ? variantLabel.get(String(row.variant_id)) || null : null,
      previousQuantity: Number(row.previous_qty),
      newQuantity: Number(row.new_qty),
      change: Number(row.delta),
      reason: row.reason,
      source: row.source,
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      actor: row.actor_id ? actorName.get(String(row.actor_id)) || "Unknown user" : "System",
    })),
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    },
  };
};

module.exports = { record, recordVariantDelta, list, SOURCES };
