const { poolPromise } = require("../config/sql");
const refundSql = require("./refund-sql.service");

// ==========================================
// ANALYTICS (admin + superadmin)
//
// All numbers come from SQL aggregation. Nothing in a request is concatenated
// into SQL: the only interpolated pieces are the constant fragments below and
// a bucket expression picked from a fixed map.
// ==========================================

// Same accounting rule as the super admin dashboard: revenue is money actually
// collected and kept. 'Paid' or 'Partially Refunded' payment status, and the order
// is not cancelled / waiting to be cancelled; a partly refunded order counts for
// what is left after the confirmed refund. Refund Pending / Refunded / Failed never match.
const REVENUE_ORDER =
  "(LOWER(o.payment_status) IN ('paid', 'partially refunded') AND LOWER(o.status) NOT IN ('cancelled', 'cancellation requested', 'returned'))";

// The store trades in India: days are IST (UTC+5:30). created_at is stored UTC.
const IST_OFFSET_MINUTES = 330;
const IST_TS = "DATE_ADD(o.created_at, INTERVAL 330 MINUTE)";

const BUCKETS = {
  day: `DATE_FORMAT(${IST_TS}, '%Y-%m-%d')`,
  week: `DATE_FORMAT(DATE_SUB(DATE(${IST_TS}), INTERVAL WEEKDAY(${IST_TS}) DAY), '%Y-%m-%d')`,
  month: `DATE_FORMAT(${IST_TS}, '%Y-%m-01')`,
};

const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const httpError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const num = (value) => Number(value || 0);
const money = (value) => Math.round(num(value) * 100) / 100;

// Percentage change; null when there is nothing to compare against.
const change = (current, previous) =>
  previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;

const parseDay = (value, label) => {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw httpError(`${label} must be a date in YYYY-MM-DD format.`);
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw httpError(`${label} is not a valid date.`);
  }
  return ms;
};

const istToday = () => {
  const now = Date.now() + IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(now).toISOString().slice(0, 10);
};

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// Validates the query and returns the IST day range plus the matching UTC
// instants used in WHERE clauses (index friendly, half-open).
const resolveRange = ({ from, to, compare } = {}) => {
  const today = istToday();
  const toStr = to || today;
  const fromStr = from || iso(parseDay(toStr, "to") - 29 * DAY_MS);

  const fromMs = parseDay(fromStr, "from");
  const toMs = parseDay(toStr, "to");

  if (fromMs > toMs) throw httpError("The start date must not be after the end date.");
  if (toMs > parseDay(today, "today")) throw httpError("The end date cannot be in the future.");

  const days = Math.round((toMs - fromMs) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw httpError(`The date range cannot exceed ${MAX_RANGE_DAYS} days.`);
  }

  const toUtc = (dayMs) => new Date(dayMs - IST_OFFSET_MINUTES * 60 * 1000);

  const current = {
    from: fromStr,
    to: toStr,
    days,
    start: toUtc(fromMs),
    end: toUtc(toMs + DAY_MS),
  };

  const wantsCompare = compare === true || compare === "1" || compare === "true";
  const previous = wantsCompare
    ? {
        from: iso(fromMs - days * DAY_MS),
        to: iso(fromMs - DAY_MS),
        days,
        start: toUtc(fromMs - days * DAY_MS),
        end: toUtc(fromMs),
      }
    : null;

  const granularity = days <= 31 ? "day" : days <= 120 ? "week" : "month";

  return { current, previous, granularity };
};

// ------------------------------------------
// Per-period summary
// ------------------------------------------

const summarise = async (pool, range) => {
  const params = [range.start, range.end];

  const [[orderRows], [unitRows]] = await Promise.all([
    pool.execute(
      `
        SELECT
          COUNT(*) AS orders,
          COALESCE(SUM(CASE WHEN ${REVENUE_ORDER} THEN ${refundSql.net()} END), 0) AS revenue,
          COALESCE(SUM(CASE WHEN ${REVENUE_ORDER} THEN 1 END), 0) AS paid_orders,
          COALESCE(SUM(LOWER(o.status) = 'delivered'), 0) AS delivered,
          COALESCE(SUM(LOWER(o.status) = 'cancelled'), 0) AS cancelled,
          COALESCE(SUM(${refundSql.refunded()}), 0) AS refunded_amount,
          COALESCE(SUM(CASE WHEN ${REVENUE_ORDER} THEN o.discount_amount END), 0) AS discounts
        FROM orders o
        WHERE o.created_at >= ? AND o.created_at < ?
      `,
      params
    ),
    pool.execute(
      `
        SELECT COALESCE(SUM(oi.quantity), 0) AS units
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        WHERE o.created_at >= ? AND o.created_at < ?
          AND ${REVENUE_ORDER}
      `,
      params
    ),
  ]);

  const row = orderRows[0] || {};
  const revenue = money(row.revenue);
  const paidOrders = num(row.paid_orders);
  const orders = num(row.orders);

  return {
    revenue,
    orders,
    paidOrders,
    averageOrderValue: paidOrders > 0 ? money(revenue / paidOrders) : null,
    units: num(unitRows[0]?.units),
    delivered: num(row.delivered),
    cancelled: num(row.cancelled),
    cancellationRate: orders > 0 ? Math.round((num(row.cancelled) / orders) * 1000) / 10 : null,
    refundedAmount: money(row.refunded_amount),
    discounts: money(row.discounts),
  };
};

// ------------------------------------------
// Time series with gaps filled
// ------------------------------------------

const bucketKeys = (range, granularity) => {
  const keys = [];
  const startMs = Date.parse(`${range.from}T00:00:00Z`);
  const endMs = Date.parse(`${range.to}T00:00:00Z`);

  if (granularity === "day") {
    for (let t = startMs; t <= endMs; t += DAY_MS) keys.push(iso(t));
  } else if (granularity === "week") {
    const start = new Date(startMs);
    const mondayOffset = (start.getUTCDay() + 6) % 7;
    for (let t = startMs - mondayOffset * DAY_MS; t <= endMs; t += 7 * DAY_MS) keys.push(iso(t));
  } else {
    const start = new Date(startMs);
    let y = start.getUTCFullYear();
    let m = start.getUTCMonth();
    while (Date.UTC(y, m, 1) <= endMs) {
      keys.push(iso(Date.UTC(y, m, 1)));
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
    }
  }
  return keys;
};

const getSeries = async (pool, range, granularity) => {
  const [rows] = await pool.execute(
    `
      SELECT
        ${BUCKETS[granularity]} AS bucket,
        COUNT(*) AS orders,
        COALESCE(SUM(CASE WHEN ${REVENUE_ORDER} THEN ${refundSql.net()} END), 0) AS revenue
      FROM orders o
      WHERE o.created_at >= ? AND o.created_at < ?
      GROUP BY bucket
    `,
    [range.start, range.end]
  );

  const byKey = new Map(rows.map((r) => [r.bucket, r]));
  return bucketKeys(range, granularity).map((key) => ({
    date: key,
    orders: num(byKey.get(key)?.orders),
    revenue: money(byKey.get(key)?.revenue),
  }));
};

// ------------------------------------------
// Public entry
// ------------------------------------------

const getAnalytics = async (query = {}) => {
  const { current, previous, granularity } = resolveRange(query);
  const pool = await poolPromise;
  await refundSql.refresh(pool);
  const params = [current.start, current.end];

  const [
    summary,
    previousSummary,
    series,
    [statusRows],
    [paymentRows],
    [productRows],
    [categoryRows],
    [couponRows],
  ] = await Promise.all([
    summarise(pool, current),
    previous ? summarise(pool, previous) : Promise.resolve(null),
    getSeries(pool, current, granularity),
    pool.execute(
      `
        SELECT o.status AS status, COUNT(*) AS count
        FROM orders o
        WHERE o.created_at >= ? AND o.created_at < ?
        GROUP BY o.status
        ORDER BY count DESC
      `,
      params
    ),
    pool.execute(
      `
        SELECT
          LOWER(o.payment_method) AS method,
          COUNT(*) AS orders,
          COALESCE(SUM(o.total_amount), 0) AS revenue
        FROM orders o
        WHERE o.created_at >= ? AND o.created_at < ?
          AND ${REVENUE_ORDER}
        GROUP BY method
        ORDER BY revenue DESC
      `,
      params
    ),
    // Item revenue = unit_price x quantity (before order-level coupon and GST),
    // so these rows do not sum to the headline revenue.
    pool.execute(
      `
        SELECT
          COALESCE(oi.product_id, oi.product_name) AS product_key,
          MAX(oi.product_name) AS name,
          MAX(oi.product_image) AS image,
          SUM(oi.quantity) AS units,
          SUM(oi.quantity * oi.unit_price) AS revenue
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        WHERE o.created_at >= ? AND o.created_at < ?
          AND ${REVENUE_ORDER}
        GROUP BY product_key
        ORDER BY units DESC, revenue DESC
        LIMIT 8
      `,
      params
    ),
    pool.execute(
      `
        SELECT
          COALESCE(NULLIF(TRIM(p.category_label), ''), 'Uncategorised') AS category,
          SUM(oi.quantity) AS units,
          SUM(oi.quantity * oi.unit_price) AS revenue
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE o.created_at >= ? AND o.created_at < ?
          AND ${REVENUE_ORDER}
        GROUP BY category
        ORDER BY revenue DESC
        LIMIT 10
      `,
      params
    ),
    pool.execute(
      `
        SELECT
          UPPER(o.coupon_code) AS code,
          COUNT(*) AS uses,
          COALESCE(SUM(o.discount_amount), 0) AS discount,
          COALESCE(SUM(o.total_amount), 0) AS revenue
        FROM orders o
        WHERE o.created_at >= ? AND o.created_at < ?
          AND ${REVENUE_ORDER}
          AND o.coupon_code IS NOT NULL AND o.coupon_code <> ''
        GROUP BY code
        ORDER BY uses DESC
        LIMIT 8
      `,
      params
    ),
  ]);

  const view = (r) => ({ from: r.from, to: r.to, days: r.days });

  return {
    range: view(current),
    previousRange: previous ? view(previous) : null,
    granularity,
    currency: "INR",
    timezone: "Asia/Kolkata",
    summary,
    previousSummary,
    comparison: previousSummary
      ? {
          revenue: change(summary.revenue, previousSummary.revenue),
          orders: change(summary.orders, previousSummary.orders),
          averageOrderValue: change(
            summary.averageOrderValue || 0,
            previousSummary.averageOrderValue || 0
          ),
          units: change(summary.units, previousSummary.units),
          delivered: change(summary.delivered, previousSummary.delivered),
          cancelled: change(summary.cancelled, previousSummary.cancelled),
        }
      : null,
    series,
    statuses: statusRows.map((r) => ({ status: r.status, count: num(r.count) })),
    paymentMethods: paymentRows.map((r) => ({
      method: r.method,
      orders: num(r.orders),
      revenue: money(r.revenue),
    })),
    topProducts: productRows.map((r) => ({
      id: r.product_key,
      name: r.name || "Removed product",
      image: r.image || null,
      units: num(r.units),
      revenue: money(r.revenue),
    })),
    categories: categoryRows.map((r) => ({
      category: r.category,
      units: num(r.units),
      revenue: money(r.revenue),
    })),
    coupons: couponRows.map((r) => ({
      code: r.code,
      uses: num(r.uses),
      discount: money(r.discount),
      revenue: money(r.revenue),
    })),
  };
};

module.exports = { getAnalytics, resolveRange, bucketKeys, change };
