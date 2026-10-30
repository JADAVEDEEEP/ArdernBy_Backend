const test = require("node:test");
const assert = require("node:assert/strict");

const { nextPaymentStatus } = require("../services/payment-state.service");
const status = require("../utils/payment-status");
const refundSql = require("../services/refund-sql.service");
const deliveryDate = require("../services/delivery-date.service");

const base = { totalPaise: 94500, completedPaise: 0, openPaise: 0, hasRecords: true };
const next = (over) => nextPaymentStatus({ orderStatus: "Processing", paymentStatus: "Paid", ...base, ...over });

test("payment status words: held vs collected", () => {
  assert.ok(status.isHeld("Paid") && status.isHeld("partially refunded"));
  assert.ok(!status.isHeld("Refunded") && !status.isHeld("Refund Pending") && !status.isHeld("Pending"));
  assert.ok(status.isCollected("Refund Pending") && status.isCollected("Refunded") && status.isCollected("Partially Refunded"));
  assert.ok(!status.isCollected("Pending") && !status.isCollected("Failed"));
});

test("a confirmed partial refund makes the order Partially Refunded", () => {
  assert.equal(next({ completedPaise: 28350 }), "Partially Refunded");
});

test("a partial refund that is only pending leaves the order Paid", () => {
  assert.equal(next({ openPaise: 28350 }), null);
});

test("refunds adding up to the total make it Refunded", () => {
  assert.equal(next({ orderStatus: "Cancelled", completedPaise: 94500 }), "Refunded");
  assert.equal(next({ orderStatus: "Cancelled", paymentStatus: "Partially Refunded", completedPaise: 94500 }), "Refunded");
});

test("a cancelled order with an unfinished refund is Refund Pending, even after an earlier partial refund", () => {
  assert.equal(next({ orderStatus: "Cancelled", completedPaise: 28350, openPaise: 66150 }), "Refund Pending");
});

test("a refund that is less than the total (return with a deduction) stays Partially Refunded", () => {
  assert.equal(next({ orderStatus: "Returned", completedPaise: 61150 }), "Partially Refunded");
});

test("orders with no item-level records, or no collected money, are never touched", () => {
  assert.equal(next({ hasRecords: false, orderStatus: "Cancelled", paymentStatus: "Refund Pending" }), null);
  assert.equal(next({ paymentStatus: "Pending", completedPaise: 100 }), null);
  assert.equal(next({ paymentStatus: "Failed", completedPaise: 100 }), null);
});

test("a cancelled order whose refund is not applicable keeps its status", () => {
  assert.equal(next({ orderStatus: "Cancelled" }), null);
});

test("report SQL: item-level refunds are partial amounts; without the tables the status rule applies", async () => {
  refundSql.resetCache();
  const missing = { execute: async () => { const e = new Error("no such table"); e.code = "ER_NO_SUCH_TABLE"; throw e; } };
  await refundSql.refresh(missing);
  assert.match(refundSql.refunded(), /payment_status\) = 'refunded' THEN o\.total_amount/);
  assert.ok(!/order_cancellations/.test(refundSql.refunded()));

  refundSql.resetCache();
  await refundSql.refresh({ execute: async () => [[{ 1: 1 }]] });
  assert.match(refundSql.refunded(), /order_cancellations/);
  assert.match(refundSql.refunded(), /return_requests/);
  assert.match(refundSql.refunded(), /refund_status = 'completed'/);
  assert.match(refundSql.openRefund(), /'pending', 'processing', 'failed'/);
  assert.match(refundSql.net(), /o\.total_amount - /);
  refundSql.resetCache();
});

test("return window: starts at the recorded delivery time when the table exists, else at the last update", async () => {
  deliveryDate.resetCache();
  const missing = { execute: async () => { const e = new Error("no such table"); e.code = "ER_NO_SUCH_TABLE"; throw e; } };
  assert.ok(!(await deliveryDate.ageSql(missing)).includes("order_delivery_log"));
  assert.equal(await deliveryDate.recordDelivered(missing, "o1", "a1"), false);

  deliveryDate.resetCache();
  const calls = [];
  const present = { execute: async (sql, params) => { calls.push({ sql, params }); return [[]]; } };
  const sql = await deliveryDate.ageSql(present);
  assert.match(sql, /COALESCE\(\(SELECT d\.delivered_at FROM order_delivery_log d WHERE d\.order_id COLLATE utf8mb4_unicode_ci = orders\.id\), updated_at\)/);
  assert.equal(await deliveryDate.recordDelivered(present, "o1", "a1"), true);
  const insert = calls.find((c) => /insert into order_delivery_log/i.test(c.sql));
  assert.deepEqual(insert.params, ["o1", "a1"]);
  deliveryDate.resetCache();
});
