const { poolPromise } = require("../config/sql");
const { resolveRange } = require("./analytics.service");
const { getFinancialReport } = require("./financial-report.service");
const audit = require("./audit.service");
const refundSql = require("./refund-sql.service");

// ==========================================
// CSV EXPORTS
//
// * Orders export  : one row per order. Operational columns only by default;
//                    customer details (name, e-mail, phone, city, state,
//                    pincode - never the street address) only for a Super
//                    Admin who asks for them.
// * Sales summary  : one row per day plus a totals row (Super Admin only).
//
// Money columns keep the report definitions apart: order_total is what the
// customer was charged, amount_collected is what actually arrived,
// refunded_confirmed is only what Razorpay confirmed, refund_pending is
// started-but-unconfirmed. They are never interchangeable.
//
// Every export is rate limited by the router, authorised on the server, read
// in pages (never the whole table in memory) and written to the audit trail.
// ==========================================

const PAGE = 500;
const MAX_ROWS = 50000;

const STATUSES = ["Pending", "Confirmed", "Processing", "Packed", "Shipped", "Delivered", "Cancelled", "Returned", "Cancellation Requested"];
const PAYMENT_STATUSES = ["Pending", "Paid", "Failed", "Partially Refunded", "Refund Pending", "Refunded"];
const PAYMENT_METHODS = ["cod", "online"];

const httpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

// Spreadsheet programs run a cell that starts with = + - @ (or a tab / CR) as a
// formula. A leading apostrophe makes them treat it as plain text. Numbers are
// written as numbers and are not affected.
const csvCell = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
};

const csvLine = (cells) => cells.map(csvCell).join(",") + "\r\n";

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

// Writes with back-pressure so a slow client cannot make memory grow.
const write = (res, chunk) =>
  new Promise((resolve, reject) => {
    if (res.destroyed) return reject(new Error("client closed"));
    if (res.write(chunk)) return resolve();
    res.once("drain", resolve);
    res.once("close", () => reject(new Error("client closed")));
  });

const startCsv = (res, filename) => {
  res.status(200);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // UTF-8 byte-order mark so Excel reads rupee signs and names correctly.
  return write(res, "﻿");
};

const ORDER_COLUMNS = [
  "order_number",
  "order_date_ist",
  "order_status",
  "payment_method",
  "payment_status",
  "units",
  "subtotal",
  "discount",
  "shipping",
  "tax",
  "order_total",
  "coupon_code",
  "amount_collected",
  "refunded_confirmed",
  "refund_pending",
];
const CUSTOMER_COLUMNS = ["customer_name", "customer_email", "customer_phone", "city", "state", "pincode"];

const parseFilters = (query) => {
  const filters = {};
  const pick = (name, allowed, key) => {
    const value = query[name];
    if (value === undefined || value === "") return;
    if (typeof value !== "string" || !allowed.includes(value)) {
      throw httpError(400, `Unknown ${name}.`);
    }
    filters[key] = value;
  };
  pick("status", STATUSES, "status");
  pick("paymentStatus", PAYMENT_STATUSES, "paymentStatus");
  pick("paymentMethod", PAYMENT_METHODS, "paymentMethod");
  return filters;
};

const streamOrders = async ({ res, query, includeCustomer, actor }) => {
  const range = resolveRange({ from: query.from, to: query.to });
  const filters = parseFilters(query);
  const pool = await poolPromise;
  await refundSql.refresh(pool);

  const where = ["o.created_at >= ?", "o.created_at < ?"];
  const baseParams = [range.current.start, range.current.end];
  if (filters.status) {
    where.push("o.status = ?");
    baseParams.push(filters.status);
  }
  if (filters.paymentStatus) {
    where.push("o.payment_status = ?");
    baseParams.push(filters.paymentStatus);
  }
  if (filters.paymentMethod) {
    where.push("LOWER(o.payment_method) = ?");
    baseParams.push(filters.paymentMethod);
  }

  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM orders o WHERE ${where.join(" AND ")}`,
    baseParams
  );
  const total = Number(countRows[0]?.total || 0);

  if (total > MAX_ROWS) {
    throw httpError(413, `That is ${total} orders; the limit is ${MAX_ROWS}. Choose a shorter date range.`);
  }

  const filename = `kovenik-orders_${range.current.from}_to_${range.current.to}.csv`;
  const columns = includeCustomer ? [...ORDER_COLUMNS, ...CUSTOMER_COLUMNS] : ORDER_COLUMNS;

  const customerSelect = includeCustomer
    ? ", o.shipping_name, p.email AS customer_email, o.shipping_phone, o.shipping_city, o.shipping_state, o.shipping_pincode"
    : "";
  const customerJoin = includeCustomer ? "LEFT JOIN profiles p ON p.id = o.user_id" : "";

  let written = 0;
  let failure = null;
  let cursor = null;
  let started = false;

  try {
    await startCsv(res, filename);
    started = true;
    await write(res, csvLine(columns));

    for (;;) {
      const pageWhere = [...where];
      const pageParams = [...baseParams];
      if (cursor) {
        pageWhere.push("(o.created_at < ? OR (o.created_at = ? AND o.id < ?))");
        pageParams.push(cursor.at, cursor.at, cursor.id);
      }

      const [rows] = await pool.execute(
        `
          SELECT o.id, o.order_number, o.status, o.payment_method, o.payment_status,
                 o.subtotal, o.discount_amount, o.shipping_amount, o.tax_amount,
                 o.total_amount, o.coupon_code,
                 DATE_FORMAT(DATE_ADD(o.created_at, INTERVAL 330 MINUTE), '%Y-%m-%d %H:%i:%s') AS ist_time,
                 DATE_FORMAT(o.created_at, '%Y-%m-%d %H:%i:%s.%f') AS cursor_time,
                 (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS units,
                 ${refundSql.refunded()} AS refunded_amount,
                 ${refundSql.openRefund()} AS refund_open_amount
                 ${customerSelect}
          FROM orders o
          ${customerJoin}
          WHERE ${pageWhere.join(" AND ")}
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT ${PAGE}
        `,
        pageParams
      );

      if (rows.length === 0) break;

      let chunk = "";
      for (const row of rows) {
        const paymentStatus = String(row.payment_status || "").toLowerCase();
        const orderTotal = money(row.total_amount);
        const collected = ["paid", "partially refunded", "refund pending", "refunded"].includes(paymentStatus) ? orderTotal : 0;

        const cells = [
          row.order_number,
          row.ist_time,
          row.status,
          row.payment_method,
          row.payment_status,
          Number(row.units || 0),
          money(row.subtotal),
          money(row.discount_amount),
          money(row.shipping_amount),
          money(row.tax_amount),
          orderTotal,
          row.coupon_code,
          collected,
          money(row.refunded_amount),
          money(row.refund_open_amount),
        ];
        if (includeCustomer) {
          cells.push(
            row.shipping_name,
            row.customer_email,
            row.shipping_phone,
            row.shipping_city,
            row.shipping_state,
            row.shipping_pincode
          );
        }
        chunk += csvLine(cells);
      }

      await write(res, chunk);
      written += rows.length;

      const last = rows[rows.length - 1];
      cursor = { at: last.cursor_time, id: last.id };
      if (rows.length < PAGE) break;
    }

    res.end();
  } catch (error) {
    failure = error;
    if (!started) throw error; // nothing sent yet: the caller can answer normally
    // Headers are gone; end the broken download. The audit entry records it.
    res.destroy();
  } finally {
    await audit.record({
      actor,
      action: "export.orders",
      resourceType: "export",
      resourceId: filename,
      outcome: failure ? "failure" : "success",
      reason: failure ? String(failure.message).slice(0, 200) : null,
      after: {
        rows: written,
        from: range.current.from,
        to: range.current.to,
        filters,
        includesCustomerDetails: Boolean(includeCustomer),
      },
    });
  }
};

const SUMMARY_COLUMNS = [
  "date_ist",
  "orders",
  "gross_order_value",
  "amount_collected",
  "refunded_confirmed",
  "refund_pending",
  "failed_payments",
  "cancelled_value",
];

const streamSalesSummary = async ({ res, query, actor }) => {
  const report = await getFinancialReport({ from: query.from, to: query.to });
  const filename = `kovenik-sales-summary_${report.range.from}_to_${report.range.to}.csv`;

  let failure = null;
  try {
    await startCsv(res, filename);
    await write(res, csvLine(SUMMARY_COLUMNS));
    let chunk = "";
    for (const day of report.daily) {
      chunk += csvLine([
        day.date,
        day.orders,
        day.grossOrderValue,
        day.collected,
        day.refunded,
        day.refundPending,
        day.failed,
        day.cancelled,
      ]);
    }
    const t = report.totals;
    chunk += csvLine([
      "TOTAL",
      t.orders,
      t.grossOrderValue,
      t.payments.collected,
      t.refunds.refunded,
      t.refunds.refundPending,
      t.payments.failed,
      t.cancellations.cancelledValue,
    ]);
    await write(res, chunk);
    res.end();
  } catch (error) {
    failure = error;
    res.destroy();
  } finally {
    await audit.record({
      actor,
      action: "export.sales_summary",
      resourceType: "export",
      resourceId: filename,
      outcome: failure ? "failure" : "success",
      after: { days: report.daily.length, from: report.range.from, to: report.range.to },
    });
  }
};

module.exports = { streamOrders, streamSalesSummary, csvCell, csvLine };
