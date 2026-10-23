const { poolPromise } = require("../config/sql");

// ==========================================
// SHARED SQL FRAGMENTS
// Constants only - no request data is ever concatenated into SQL.
// ==========================================

// Accounts closed through "delete account" keep their row for order history but
// get a placeholder e-mail. They are not real users any more.
const NOT_DELETED = "email NOT LIKE '%@deleted.ardenby.local'";

// Revenue = money actually collected and still kept. Online orders are 'Paid'
// once Razorpay confirms; COD orders flip to 'Paid' on delivery. Failed,
// pending, 'Refund Pending' and 'Refunded' payments never match, and cancelled
// orders (or ones waiting to be cancelled) are excluded even if still 'Paid'.
const REVENUE_ORDER =
  "(LOWER(o.payment_status) = 'paid' AND LOWER(o.status) NOT IN ('cancelled', 'cancellation requested'))";

// The store trades in India: day buckets use IST (UTC+5:30). created_at is UTC.
const IST_DAY = "DATE(DATE_ADD(o.created_at, INTERVAL 330 MINUTE))";
const IST_TODAY = "DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 330 MINUTE))";

const LOW_STOCK_LIMIT = 5;
const ALLOWED_RANGES = [7, 30, 90];

const ROLES = ["customer", "admin", "superadmin"];

const httpError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const num = (value) => Number(value || 0);
const money = (value) => Math.round(num(value) * 100) / 100;
const pct = (current, previous) =>
  previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;

// ==========================================
// DASHBOARD
// ==========================================

const getDashboard = async ({ days } = {}) => {
  const range = ALLOWED_RANGES.includes(days) ? days : 30;
  const pool = await poolPromise;

  const [
    [accountRows],
    [catalogRows],
    [orderRows],
    [revenueRows],
    [seriesRows],
    [statusRows],
    [paymentRows],
    [recentRows],
    [topRows],
    [customerRows],
  ] = await Promise.all([
    pool.execute(
      `
        SELECT
          SUM(role = 'customer' AND is_active = 1) AS customers,
          SUM(role = 'admin' AND is_active = 1) AS admins,
          SUM(role = 'superadmin' AND is_active = 1) AS superadmins
        FROM profiles
        WHERE ${NOT_DELETED}
      `
    ),
    pool.execute(
      `
        SELECT
          COUNT(*) AS products,
          COALESCE(SUM(inventory <= 0), 0) AS out_of_stock,
          COALESCE(SUM(inventory > 0 AND inventory <= ${LOW_STOCK_LIMIT}), 0) AS low_stock,
          COALESCE(SUM(inventory), 0) AS units
        FROM products
      `
    ),
    pool.execute("SELECT COUNT(*) AS orders FROM orders"),
    pool.execute(
      `
        SELECT
          DATE_FORMAT(${IST_TODAY}, '%Y-%m-%d') AS today,
          COALESCE(SUM(CASE WHEN ${REVENUE_ORDER} THEN o.total_amount END), 0) AS total_revenue,
          COALESCE(SUM(CASE WHEN ${REVENUE_ORDER} THEN 1 END), 0) AS paid_orders,
          COALESCE(SUM(CASE WHEN ${REVENUE_ORDER} AND ${IST_DAY} = ${IST_TODAY}
            THEN o.total_amount END), 0) AS revenue_today,
          COALESCE(SUM(CASE WHEN ${IST_DAY} = ${IST_TODAY} THEN 1 END), 0) AS orders_today,
          COALESCE(SUM(CASE WHEN ${REVENUE_ORDER} AND ${IST_DAY} > DATE_SUB(${IST_TODAY}, INTERVAL 7 DAY)
            THEN o.total_amount END), 0) AS revenue_7d,
          COALESCE(SUM(CASE WHEN ${IST_DAY} > DATE_SUB(${IST_TODAY}, INTERVAL 7 DAY) THEN 1 END), 0) AS orders_7d,
          COALESCE(SUM(CASE WHEN ${REVENUE_ORDER} AND ${IST_DAY} > DATE_SUB(${IST_TODAY}, INTERVAL 14 DAY)
            AND ${IST_DAY} <= DATE_SUB(${IST_TODAY}, INTERVAL 7 DAY)
            THEN o.total_amount END), 0) AS revenue_prev_7d,
          COALESCE(SUM(CASE WHEN ${REVENUE_ORDER} AND ${IST_DAY} > DATE_SUB(${IST_TODAY}, INTERVAL 30 DAY)
            THEN o.total_amount END), 0) AS revenue_30d,
          COALESCE(SUM(CASE WHEN ${IST_DAY} > DATE_SUB(${IST_TODAY}, INTERVAL 30 DAY) THEN 1 END), 0) AS orders_30d,
          COALESCE(SUM(CASE WHEN ${REVENUE_ORDER} AND ${IST_DAY} > DATE_SUB(${IST_TODAY}, INTERVAL 60 DAY)
            AND ${IST_DAY} <= DATE_SUB(${IST_TODAY}, INTERVAL 30 DAY)
            THEN o.total_amount END), 0) AS revenue_prev_30d
        FROM orders o
      `
    ),
    pool.execute(
      `
        SELECT
          DATE_FORMAT(${IST_DAY}, '%Y-%m-%d') AS day,
          COUNT(*) AS orders,
          COALESCE(SUM(CASE WHEN ${REVENUE_ORDER} THEN o.total_amount END), 0) AS revenue
        FROM orders o
        WHERE ${IST_DAY} > DATE_SUB(${IST_TODAY}, INTERVAL ${range} DAY)
        GROUP BY day
        ORDER BY day
      `
    ),
    pool.execute(
      "SELECT status, COUNT(*) AS count FROM orders GROUP BY status ORDER BY count DESC"
    ),
    pool.execute(
      "SELECT payment_status AS status, COUNT(*) AS count FROM orders GROUP BY payment_status ORDER BY count DESC"
    ),
    pool.execute(
      `
        SELECT
          o.id,
          o.order_number,
          COALESCE(NULLIF(TRIM(o.shipping_name), ''), p.full_name, p.email) AS customer,
          p.email AS customer_email,
          o.total_amount,
          o.payment_method,
          o.payment_status,
          o.status,
          DATE_FORMAT(o.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at
        FROM orders o
        LEFT JOIN profiles p ON p.id = o.user_id
        ORDER BY o.created_at DESC
        LIMIT 10
      `
    ),
    pool.execute(
      `
        SELECT
          oi.product_id,
          MAX(oi.product_name) AS name,
          SUM(oi.quantity) AS units,
          SUM(oi.quantity * oi.unit_price) AS revenue
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        WHERE ${REVENUE_ORDER}
        GROUP BY oi.product_id
        ORDER BY units DESC, revenue DESC
        LIMIT 5
      `
    ),
    pool.execute(
      `
        SELECT
          COALESCE(SUM(role = 'customer' AND is_active = 1
            AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)), 0) AS new_7d,
          COALESCE(SUM(role = 'customer' AND is_active = 1
            AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)), 0) AS new_30d,
          COALESCE(SUM(role = 'customer' AND is_active = 0), 0) AS deactivated,
          COALESCE(SUM(role = 'customer' AND is_active = 1 AND email_verified = 1), 0) AS verified,
          (
            SELECT COUNT(DISTINCT o.user_id)
            FROM orders o
            INNER JOIN profiles c ON c.id = o.user_id AND c.role = 'customer'
            WHERE c.is_active = 1
          ) AS with_orders
        FROM profiles
        WHERE ${NOT_DELETED}
      `
    ),
  ]);

  const accounts = accountRows[0] || {};
  const catalog = catalogRows[0] || {};
  const revenue = revenueRows[0] || {};
  const customers = customerRows[0] || {};

  // Fill days without orders so the chart has an unbroken axis.
  const byDay = new Map(seriesRows.map((row) => [row.day, row]));
  const series = [];
  const [y, m, d] = String(revenue.today).slice(0, 10).split("-").map(Number);
  for (let offset = range - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(y, m - 1, d - offset)).toISOString().slice(0, 10);
    const row = byDay.get(date);
    series.push({
      date,
      orders: row ? num(row.orders) : 0,
      revenue: row ? money(row.revenue) : 0,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    range,
    stats: {
      totalCustomers: num(accounts.customers),
      totalProducts: num(catalog.products),
      totalOrders: num(orderRows[0]?.orders),
      totalCommonAdmins: num(accounts.admins),
      totalSuperAdmins: num(accounts.superadmins),
      totalRevenue: money(revenue.total_revenue),
    },
    revenue: {
      paidOrders: num(revenue.paid_orders),
      today: money(revenue.revenue_today),
      last7Days: money(revenue.revenue_7d),
      last30Days: money(revenue.revenue_30d),
      last7DaysChange: pct(num(revenue.revenue_7d), num(revenue.revenue_prev_7d)),
      last30DaysChange: pct(num(revenue.revenue_30d), num(revenue.revenue_prev_30d)),
      averageOrderValue:
        num(revenue.paid_orders) > 0
          ? money(num(revenue.total_revenue) / num(revenue.paid_orders))
          : 0,
    },
    orders: {
      today: num(revenue.orders_today),
      last7Days: num(revenue.orders_7d),
      last30Days: num(revenue.orders_30d),
      byStatus: statusRows.map((r) => ({ status: r.status, count: num(r.count) })),
      byPaymentStatus: paymentRows.map((r) => ({ status: r.status, count: num(r.count) })),
    },
    series,
    recentOrders: recentRows.map((r) => ({
      id: r.id,
      orderNumber: r.order_number,
      customer: r.customer || "Customer",
      customerEmail: r.customer_email || null,
      amount: money(r.total_amount),
      paymentMethod: r.payment_method,
      paymentStatus: r.payment_status,
      status: r.status,
      createdAt: r.created_at,
    })),
    products: {
      total: num(catalog.products),
      outOfStock: num(catalog.out_of_stock),
      lowStock: num(catalog.low_stock),
      lowStockLimit: LOW_STOCK_LIMIT,
      unitsInStock: num(catalog.units),
      topSelling: topRows.map((r) => ({
        productId: r.product_id,
        name: r.name,
        units: num(r.units),
        revenue: money(r.revenue),
      })),
    },
    customers: {
      total: num(accounts.customers),
      newLast7Days: num(customers.new_7d),
      newLast30Days: num(customers.new_30d),
      verified: num(customers.verified),
      withOrders: num(customers.with_orders),
      deactivated: num(customers.deactivated),
    },
  };
};

// ==========================================
// USERS
// ==========================================

const toUser = (row) => ({
  id: row.id,
  fullName: row.full_name,
  email: row.email,
  phone: row.phone,
  role: row.role,
  authProvider: row.auth_provider,
  emailVerified: Boolean(row.email_verified),
  isActive: Boolean(row.is_active),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// password_hash / google_id are never selected.
const USER_COLUMNS = `
  id,
  full_name,
  email,
  phone,
  role,
  auth_provider,
  email_verified,
  is_active,
  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at,
  DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%sZ') AS updated_at
`;

const escapeLike = (value) => value.replace(/[\\%_]/g, "\\$&");

const listUsers = async ({ search, role, status, page, limit } = {}) => {
  const pool = await poolPromise;

  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  const pageNumber = Math.max(parseInt(page, 10) || 1, 1);

  const where = [NOT_DELETED];
  const params = [];

  if (role && ROLES.includes(role)) {
    where.push("role = ?");
    params.push(role);
  }

  if (status === "active") where.push("is_active = 1");
  if (status === "inactive") where.push("is_active = 0");

  const term = typeof search === "string" ? search.trim().slice(0, 100) : "";
  if (term) {
    const like = `%${escapeLike(term)}%`;
    where.push("(full_name LIKE ? OR email LIKE ? OR phone LIKE ?)");
    params.push(like, like, like);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const [[totalRow], [summaryRows], [rows]] = await Promise.all([
    pool.execute(`SELECT COUNT(*) AS total FROM profiles ${whereSql}`, params),
    pool.execute(
      `
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(role = 'customer'), 0) AS customers,
          COALESCE(SUM(role = 'admin'), 0) AS admins,
          COALESCE(SUM(role = 'superadmin'), 0) AS superadmins,
          COALESCE(SUM(is_active = 0), 0) AS inactive
        FROM profiles
        WHERE ${NOT_DELETED}
      `
    ),
    // pageSize / offset are validated integers, never request strings.
    pool.execute(
      `
        SELECT ${USER_COLUMNS}
        FROM profiles
        ${whereSql}
        ORDER BY created_at DESC, id
        LIMIT ${pageSize} OFFSET ${(pageNumber - 1) * pageSize}
      `,
      params
    ),
  ]);

  const total = num(totalRow[0]?.total);
  const summary = summaryRows[0] || {};

  return {
    users: rows.map(toUser),
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    },
    summary: {
      total: num(summary.total),
      customers: num(summary.customers),
      admins: num(summary.admins),
      superadmins: num(summary.superadmins),
      inactive: num(summary.inactive),
    },
  };
};

// Runs a change against one account inside a transaction. All active super
// admins are locked first so two simultaneous requests cannot each see "there is
// another super admin" and together remove the last one.
const changeAccount = async ({ actorId, targetId, apply }) => {
  const pool = await poolPromise;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [supers] = await connection.execute(
      "SELECT id FROM profiles WHERE role = 'superadmin' AND is_active = 1 FOR UPDATE"
    );

    const [rows] = await connection.execute(
      `SELECT id, email, role, is_active FROM profiles WHERE id = ? AND ${NOT_DELETED} FOR UPDATE`,
      [targetId]
    );
    const target = rows[0];

    if (!target) throw httpError("User not found.", 404);

    if (target.id === actorId) {
      throw httpError("You cannot change your own account here.", 403);
    }

    const isActiveSuper = target.role === "superadmin" && target.is_active === 1;
    const isOnlySuper = isActiveSuper && supers.length <= 1;

    await apply({ connection, target, isOnlySuper });

    await connection.commit();

    const [updated] = await pool.execute(
      `SELECT ${USER_COLUMNS} FROM profiles WHERE id = ? LIMIT 1`,
      [targetId]
    );

    return toUser(updated[0]);
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
};

const setUserStatus = ({ actorId, targetId, isActive }) =>
  changeAccount({
    actorId,
    targetId,
    apply: async ({ connection, target, isOnlySuper }) => {
      if (!isActive && isOnlySuper) {
        throw httpError("The last active Super Admin cannot be deactivated.", 409);
      }

      await connection.execute(
        "UPDATE profiles SET is_active = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
        [isActive ? 1 : 0, target.id]
      );
    },
  });

const setUserRole = ({ actorId, targetId, role }) =>
  changeAccount({
    actorId,
    targetId,
    apply: async ({ connection, target, isOnlySuper }) => {
      if (target.role === role) return;

      if (target.role === "superadmin" && role !== "superadmin" && isOnlySuper) {
        throw httpError("The last active Super Admin cannot be demoted.", 409);
      }

      if (!target.is_active) {
        throw httpError("Reactivate this account before changing its role.", 409);
      }

      await connection.execute(
        "UPDATE profiles SET role = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
        [role, target.id]
      );
    },
  });

module.exports = {
  ROLES,
  ALLOWED_RANGES,
  getDashboard,
  listUsers,
  setUserStatus,
  setUserRole,
};
