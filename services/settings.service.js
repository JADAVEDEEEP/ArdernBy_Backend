const { poolPromise } = require("../config/sql");
const { FREE_SHIPPING_THRESHOLD, SHIPPING_FEE, GST_RATE } = require("../utils/pricing");

// ==========================================
// ADMIN SETTINGS
//
// One row per section in `store_settings`, so saving one section can never
// overwrite another. Every field is whitelisted and validated here; unknown
// fields are rejected. Nothing secret lives in this module or its responses.
// ==========================================

const httpError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const PHONE = /^[0-9+()\-\s]{7,20}$/;

const text = (label, max, { required = false } = {}) => (value) => {
  const v = typeof value === "string" ? value.trim() : "";
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw httpError(`${label} must be text.`);
  }
  if (required && !v) throw httpError(`${label} is required.`);
  if (v.length > max) throw httpError(`${label} must be at most ${max} characters.`);
  // Control characters have no place in any of these fields.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v)) {
    throw httpError(`${label} contains invalid characters.`);
  }
  return v;
};

const email = (label) => (value) => {
  const v = text(label, 254)(value);
  if (v && !EMAIL.test(v)) throw httpError(`${label} is not a valid email address.`);
  return v;
};

const phone = (label) => (value) => {
  const v = text(label, 20)(value);
  if (v && !PHONE.test(v)) throw httpError(`${label} is not a valid phone number.`);
  return v;
};

const bool = (label) => (value) => {
  if (typeof value !== "boolean") throw httpError(`${label} must be on or off.`);
  return value;
};

const int = (label, min, max) => (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw httpError(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return n;
};

const SECTIONS = {
  store: {
    fields: {
      storeName: text("Store name", 80, { required: true }),
      contactEmail: email("Contact email"),
      contactPhone: phone("Contact phone"),
      description: text("Store description", 500),
      supportEmail: email("Support email"),
      supportPhone: phone("Support phone"),
      supportHours: text("Support hours", 120),
    },
    defaults: {
      storeName: "KOVENIK",
      contactEmail: "",
      contactPhone: "",
      description: "",
      supportEmail: "",
      supportPhone: "",
      supportHours: "",
    },
  },
  brand: {
    fields: {
      displayName: text("Brand display name", 60, { required: true }),
      announcementEnabled: bool("Announcement"),
      announcement: text("Announcement text", 160),
      metaTitle: text("Meta title", 70),
      metaDescription: text("Meta description", 200),
    },
    defaults: {
      displayName: "KOVENIK",
      announcementEnabled: false,
      announcement: "",
      metaTitle: "",
      metaDescription: "",
    },
  },
  // Return policy. Deliberately closed until the owner chooses a window:
  // nothing here is a default business rule.
  returns: {
    fields: {
      enabled: bool("Accept return requests"),
      windowDays: int("Return window (days)", 1, 365),
    },
    defaults: {
      enabled: false,
      windowDays: 0,
    },
  },
  notifications: {
    fields: {
      newOrders: bool("New orders"),
      lowStock: bool("Low-stock alerts"),
      failedPayments: bool("Failed payments"),
      cancellations: bool("Order cancellations"),
      lowStockThreshold: int("Low-stock threshold", 1, 100),
    },
    defaults: {
      newOrders: true,
      lowStock: true,
      failedPayments: true,
      cancellations: true,
      lowStockThreshold: 5,
    },
  },
};

const SECTION_NAMES = Object.keys(SECTIONS);

let ensured = null;

// Additive and idempotent. Runs once per process, on first use of settings.
const ensureTable = (pool) => {
  if (!ensured) {
    ensured = pool
      .query(
        `
          CREATE TABLE IF NOT EXISTS store_settings (
            section VARCHAR(40) NOT NULL PRIMARY KEY,
            value TEXT NOT NULL,
            updated_by CHAR(36) NULL,
            updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
              ON UPDATE CURRENT_TIMESTAMP(6)
          )
        `
      )
      .catch((error) => {
        ensured = null;
        throw error;
      });
  }
  return ensured;
};

const parseStored = (section, raw) => {
  const { defaults, fields } = SECTIONS[section];
  let stored = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
  } catch {
    stored = {};
  }
  const merged = { ...defaults };
  for (const key of Object.keys(fields)) {
    if (stored[key] !== undefined) merged[key] = stored[key];
  }
  return merged;
};

// Read-only facts the application already enforces elsewhere.
const readOnlyConfig = () => ({
  currency: "INR",
  timezone: "Asia/Kolkata",
  shipping: {
    freeShippingThreshold: FREE_SHIPPING_THRESHOLD,
    shippingFee: SHIPPING_FEE,
    gstRate: GST_RATE,
  },
  orderStatuses: ["Pending", "Confirmed", "Processing", "Shipped", "Delivered", "Cancelled", "Returned"],
});

const getAllSettings = async () => {
  const pool = await poolPromise;
  await ensureTable(pool);

  const [rows] = await pool.execute("SELECT section, value, updated_at FROM store_settings");
  const bySection = new Map(rows.map((r) => [r.section, r]));

  const settings = {};
  const updatedAt = {};
  for (const name of SECTION_NAMES) {
    const row = bySection.get(name);
    settings[name] = parseStored(name, row ? row.value : "{}");
    updatedAt[name] = row ? row.updated_at : null;
  }

  return { settings, updatedAt, config: readOnlyConfig() };
};

const updateSection = async (section, body, userId) => {
  if (!SECTION_NAMES.includes(section)) throw httpError("Unknown settings section.", 404);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError("Settings must be sent as an object.");
  }

  const { fields } = SECTIONS[section];
  const unknown = Object.keys(body).filter((key) => !(key in fields));
  if (unknown.length) throw httpError(`Unknown setting: ${unknown[0]}.`);

  const pool = await poolPromise;
  await ensureTable(pool);

  // Validate every submitted field; fields that were not sent keep their value.
  const clean = {};
  for (const [key, value] of Object.entries(body)) {
    clean[key] = fields[key](value);
  }
  if (Object.keys(clean).length === 0) throw httpError("No settings were provided.");

  const [rows] = await pool.execute("SELECT value FROM store_settings WHERE section = ? LIMIT 1", [section]);
  const next = { ...parseStored(section, rows[0] ? rows[0].value : "{}"), ...clean };

  await pool.execute(
    `
      INSERT INTO store_settings (section, value, updated_by)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)
    `,
    [section, JSON.stringify(next), userId || null]
  );

  return next;
};

// ------------------------------------------
// Alerts: derived live from orders / products and filtered by preferences.
// ------------------------------------------

const getAlerts = async () => {
  const pool = await poolPromise;
  await ensureTable(pool);

  const [rows] = await pool.execute("SELECT value FROM store_settings WHERE section = 'notifications' LIMIT 1");
  const prefs = parseStored("notifications", rows[0] ? rows[0].value : "{}");
  const threshold = prefs.lowStockThreshold;

  const [[orders], [stock]] = await Promise.all([
    pool.execute(
      `
        SELECT
          COALESCE(SUM(created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)
            AND LOWER(payment_status) <> 'failed'), 0) AS new_orders,
          COALESCE(SUM(LOWER(payment_status) = 'failed'
            AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)), 0) AS failed_payments,
          COALESCE(SUM(LOWER(status) IN ('cancelled', 'cancellation requested')
            AND updated_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)), 0) AS cancellations
        FROM orders
      `
    ),
    pool.execute(
      `
        SELECT
          COALESCE(SUM(inventory > 0 AND inventory <= ?), 0) AS low_stock,
          COALESCE(SUM(inventory <= 0), 0) AS out_of_stock
        FROM products
      `,
      [threshold]
    ),
  ]);

  const o = orders[0] || {};
  const s = stock[0] || {};
  const alerts = [];

  if (prefs.newOrders && Number(o.new_orders) > 0) {
    alerts.push({
      type: "new-orders",
      title: `${Number(o.new_orders)} new order${Number(o.new_orders) === 1 ? "" : "s"} in the last 24 hours`,
      href: "/admin/orders",
    });
  }
  if (prefs.lowStock && (Number(s.low_stock) > 0 || Number(s.out_of_stock) > 0)) {
    const parts = [];
    if (Number(s.out_of_stock) > 0) parts.push(`${Number(s.out_of_stock)} out of stock`);
    if (Number(s.low_stock) > 0) parts.push(`${Number(s.low_stock)} low (${threshold} or fewer)`);
    alerts.push({ type: "low-stock", title: `Inventory: ${parts.join(", ")}`, href: "/admin/inventory" });
  }
  if (prefs.failedPayments && Number(o.failed_payments) > 0) {
    alerts.push({
      type: "failed-payments",
      title: `${Number(o.failed_payments)} failed payment${Number(o.failed_payments) === 1 ? "" : "s"} this week`,
      href: "/admin/orders",
    });
  }
  if (prefs.cancellations && Number(o.cancellations) > 0) {
    alerts.push({
      type: "cancellations",
      title: `${Number(o.cancellations)} cancellation${Number(o.cancellations) === 1 ? "" : "s"} this week`,
      href: "/admin/orders",
    });
  }

  return alerts;
};

module.exports = { getAllSettings, updateSection, getAlerts, SECTIONS };
