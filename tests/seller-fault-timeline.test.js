const test = require("node:test");
const assert = require("node:assert/strict");

const calc = require("../services/refund-calc.service");
const reasons = require("../utils/reasons");
const { calculateOrderTotals } = require("../utils/pricing");
const { addWorkingDays, refundWindow, REFUND_WINDOW_TEXT } = require("../utils/working-days");
const { buildTimeline } = require("../services/return-timeline.service");
const { nextPaymentStatus } = require("../services/payment-state.service");
const { TEMPLATES } = require("../services/email/templates");

// ---- a real COD order: 2 x 500 + 1 x 1000 goods, 49 shipping, COD fee ----------------------------

const LINES = [
  { id: "a", product_name: "Tee", quantity: 2, unit_price: 500 },
  { id: "b", product_name: "Hoodie", quantity: 1, unit_price: 1000 },
];
const totals = calculateOrderTotals(2000, 0, { cod: true });
const COD_ORDER = {
  discount_amount: 0,
  tax_amount: totals.taxAmount,
  shipping_amount: totals.shippingAmount,
  cod_fee: totals.codFee,
  cod_fee_tax: totals.codFeeTax,
  total_amount: totals.totalAmount,
};
const PREPAID = { ...COD_ORDER, cod_fee: 0, cod_fee_tax: 0, total_amount: totals.totalAmount - totals.codFee - totals.codFeeTax };

const refund = (order, picks, extra = {}) => calc.computeRefund({ order, lines: LINES, picks, ...extra });

test("seller-fault reasons: wrong / damaged / defective / quality / not as described; wrong size and other are the customer's", () => {
  for (const code of ["wrong_product", "damaged", "defective", "quality_issue", "not_as_described"]) {
    assert.ok(reasons.SELLER_FAULT_RETURN_REASONS.includes(code), code);
  }
  for (const code of ["wrong_size", "other", "changed_mind", ""]) {
    assert.ok(!reasons.SELLER_FAULT_RETURN_REASONS.includes(code), code);
  }
  // every seller-fault code is a real return reason
  for (const code of reasons.SELLER_FAULT_RETURN_REASONS) assert.ok(reasons.codes(reasons.RETURN_REASONS).includes(code));
});

test("change of mind on COD: goods + their GST only; shipping and COD fee are kept", () => {
  const r = refund(COD_ORDER, [{ orderItemId: "b", quantity: 1 }]);
  assert.equal(r.goods, 1050); // the hoodie plus its 5% GST
  assert.equal(r.shipping, 0);
  assert.equal(r.codFee, 0);
  assert.equal(r.final, 1050);
});

test("seller fault on COD, the whole order back: goods + GST + all shipping + all COD fee with its GST", () => {
  const r = refund(COD_ORDER, [{ orderItemId: "a", quantity: 2 }, { orderItemId: "b", quantity: 1 }], { sellerFault: true });
  assert.equal(r.shipping, 49);
  assert.equal(r.codFee, 30.45);
  assert.equal(r.final, COD_ORDER.total_amount); // everything the customer paid
  assert.equal(r.includesShipping, true);
  assert.equal(r.sellerFault, true);
});

test("seller fault, partial return: shipping and fee follow the share of goods returned (never more)", () => {
  const r = refund(COD_ORDER, [{ orderItemId: "b", quantity: 1 }], { sellerFault: true });
  // the hoodie is half of the goods
  assert.equal(r.shipping, 24.5);
  assert.equal(r.codFee, 15.22); // floor of 30.45 / 2
  assert.equal(r.final, 1050 + 24.5 + 15.22);
});

test("several seller-fault returns can never refund more shipping / fee than was paid", () => {
  const first = refund(COD_ORDER, [{ orderItemId: "a", quantity: 1 }], { sellerFault: true });
  const second = refund(COD_ORDER, [{ orderItemId: "a", quantity: 1, offset: 1 }], { sellerFault: true });
  const third = refund(COD_ORDER, [{ orderItemId: "b", quantity: 1 }], { sellerFault: true });
  const shipping = first.shippingPaise + second.shippingPaise + third.shippingPaise;
  const fee = first.codFeePaise + second.codFeePaise + third.codFeePaise;
  assert.ok(shipping <= 4900, `shipping ${shipping}`);
  assert.ok(fee <= 3045, `fee ${fee}`);
  assert.ok(first.final + second.final + third.final <= calc.toPaise(COD_ORDER.total_amount) / 100);
});

test("seller fault on a PREPAID order: shipping comes back, there is no COD fee", () => {
  const r = refund(PREPAID, [{ orderItemId: "a", quantity: 2 }, { orderItemId: "b", quantity: 1 }], { sellerFault: true });
  assert.equal(r.codFee, 0);
  assert.equal(r.shipping, 49);
  assert.equal(r.final, PREPAID.total_amount);
});

test("a seller-fault refund still cannot exceed what was paid", () => {
  assert.throws(
    () => refund(COD_ORDER, [{ orderItemId: "b", quantity: 1 }], { sellerFault: true, alreadyRefundedPaise: calc.toPaise(COD_ORDER.total_amount) - 100 }),
    (e) => e.code === "EXCEEDS_PAID"
  );
});

test("a member's free-shipping order has no shipping to refund", () => {
  const free = calculateOrderTotals(2000, 0, { cod: true, freeShipping: true });
  const order = { ...COD_ORDER, shipping_amount: free.shippingAmount, total_amount: free.totalAmount };
  const r = refund(order, [{ orderItemId: "a", quantity: 2 }, { orderItemId: "b", quantity: 1 }], { sellerFault: true });
  assert.equal(r.shipping, 0);
  assert.equal(r.final, order.total_amount);
});

test("existing behaviour is untouched when sellerFault is not given", () => {
  const r = refund(COD_ORDER, [{ orderItemId: "a", quantity: 2 }, { orderItemId: "b", quantity: 1 }]);
  assert.equal(r.shipping, 0);
  assert.equal(r.codFee, 0);
  assert.equal(r.final, 2100);
  const cancel = refund(COD_ORDER, [{ orderItemId: "a", quantity: 2 }, { orderItemId: "b", quantity: 1 }], { includeShipping: true });
  assert.equal(cancel.shipping, 49);
  assert.equal(cancel.codFee, 0);
});

// ---- order payment status with a refunded COD fee -------------------------------------------------

test("a fully refunded seller-fault COD order is Refunded; a partial one that includes the fee is not", () => {
  const goodsAndShipping = calc.toPaise(COD_ORDER.total_amount) - calc.toPaise(COD_ORDER.cod_fee) - calc.toPaise(COD_ORDER.cod_fee_tax);
  const feePaise = calc.toPaise(COD_ORDER.cod_fee) + calc.toPaise(COD_ORDER.cod_fee_tax);
  const base = { orderStatus: "Returned", paymentStatus: "Paid", hasRecords: true, openPaise: 0, totalPaise: goodsAndShipping };
  // everything refunded: goods + shipping + the fee; the page subtracts the fee again -> equal
  assert.equal(nextPaymentStatus({ ...base, completedPaise: goodsAndShipping + feePaise - feePaise }), "Refunded");
  // a big partial refund that includes a fee share must not look complete
  assert.equal(nextPaymentStatus({ ...base, completedPaise: goodsAndShipping - 1 }), "Partially Refunded");
});

// ---- refund timeline ----------------------------------------------------------------------------------

test("working days skip weekends; the window is 5 to 7 working days", () => {
  // Monday 2026-11-09
  assert.equal(addWorkingDays("2026-11-09", 5).toISOString().slice(0, 10), "2026-11-16");
  assert.equal(addWorkingDays("2026-11-13", 1).toISOString().slice(0, 10), "2026-11-16"); // Friday -> Monday
  assert.deepEqual(refundWindow("2026-11-09T10:00:00.000Z"), { from: "2026-11-16", to: "2026-11-18" });
  assert.equal(refundWindow(null), null);
  assert.match(REFUND_WINDOW_TEXT, /5.7 working days/);
});

const iso = (d) => `2026-11-${d}T10:00:00.000Z`;
const baseRow = {
  id: "r1",
  status: "Requested",
  created_iso: iso("02"),
  decided_iso: null,
  shipped_iso: null,
  received_iso: null,
  inspected_iso: null,
  completed_iso: null,
  refund_status: null,
  refund_method: null,
  payout_id: null,
  refund_id: null,
  payout_initiated_at: null,
  refund_completed_at: null,
};
const keys = (t) => t.stages.map((s) => `${s.key}:${s.state}`);

test("timeline: a new request is done, approval is the current stage, nothing later is done", () => {
  const t = buildTimeline({ row: baseRow, history: [] });
  assert.deepEqual(keys(t), [
    "requested:done", "decision:current", "shipped:upcoming", "received:upcoming",
    "inspection:upcoming", "refund_approved:upcoming", "refund_processing:upcoming", "refund_final:upcoming",
  ]);
  assert.equal(t.currentKey, "decision");
  assert.equal(t.estimate.basis, null); // nothing to count from yet
});

test("timeline: a stage is done only when its event is stored (received without inspection)", () => {
  const row = { ...baseRow, status: "Received", decided_iso: iso("03"), shipped_iso: iso("04"), received_iso: iso("06") };
  const t = buildTimeline({ row, history: [] });
  assert.deepEqual(keys(t).slice(0, 5), ["requested:done", "decision:done", "shipped:done", "received:done", "inspection:current"]);
  assert.equal(t.stages.find((s) => s.key === "received").at, iso("06"));
  assert.equal(t.stages.find((s) => s.key === "refund_approved").state, "upcoming");
});

test("timeline: rejected is its own ending, with no refund stages", () => {
  const t = buildTimeline({ row: { ...baseRow, status: "Rejected", decided_iso: iso("03"), decision_reason: "Past the window" }, history: [] });
  assert.deepEqual(keys(t), ["requested:done", "decision:rejected"]);
  assert.equal(t.outcome, "rejected");
  assert.equal(t.stages[1].note, "Past the window");
});

const inspectedRow = { ...baseRow, status: "Inspected", decided_iso: iso("03"), shipped_iso: iso("04"), received_iso: iso("06"), inspected_iso: iso("07") };
const history = [
  { to_status: "Inspected", note: "Checked", created_iso: iso("07") },
  { to_status: "Inspected", note: "Refund sent for processing: ₹1050.00", created_iso: iso("08") },
];

test("timeline: refund approved and processing show their own times; the estimate counts from approval", () => {
  const row = { ...inspectedRow, refund_status: "processing", refund_method: "razorpayx_upi", payout_id: "pout_1", payout_initiated_at: iso("08") };
  const t = buildTimeline({ row, history });
  assert.deepEqual(keys(t).slice(5), ["refund_approved:done", "refund_processing:current", "refund_final:upcoming"]);
  assert.equal(t.stages.find((s) => s.key === "refund_approved").state, "done");
  assert.equal(t.stages.find((s) => s.key === "refund_approved").at, iso("08"));
  assert.equal(t.estimate.basis, "approval");
  assert.ok(t.estimate.from && t.estimate.to);
  assert.equal(t.outcome, "in_progress");
});

test("timeline: completed is shown only when the refund is completed; failed is separate", () => {
  const done = buildTimeline({
    row: { ...inspectedRow, status: "Completed", refund_status: "completed", refund_method: "razorpayx_upi", payout_id: "p", payout_initiated_at: iso("08"), refund_completed_at: iso("09") },
    history,
  });
  assert.equal(done.stages.at(-1).state, "done");
  assert.equal(done.stages.at(-1).label, "Refund completed");
  assert.equal(done.estimate, null);
  assert.equal(done.outcome, "completed");

  const failed = buildTimeline({
    row: { ...inspectedRow, refund_status: "failed", refund_method: "razorpayx_upi", payout_id: "p", payout_initiated_at: iso("08") },
    history,
  });
  assert.equal(failed.stages.at(-1).state, "failed");
  assert.equal(failed.stages.at(-1).label, "Refund failed");
  assert.equal(failed.outcome, "refund_failed");
  assert.ok(!failed.stages.some((s) => s.state === "current"), "nothing pretends to be progressing");

  // pending / processing never show "completed"
  for (const refund_status of ["pending", "processing"]) {
    const t = buildTimeline({ row: { ...inspectedRow, refund_status }, history });
    assert.notEqual(t.stages.at(-1).state, "done", refund_status);
  }
});

test("timeline: nothing qualified for a refund -> no refund stages to wait for", () => {
  const t = buildTimeline({ row: { ...inspectedRow, status: "Completed", refund_status: null }, history: [{ to_status: "Inspected", note: "Checked", created_iso: iso("07") }] });
  assert.equal(t.stages.find((s) => s.key === "refund_approved").state, "skipped");
  assert.ok(!t.stages.some((s) => s.key === "refund_final"));
  assert.equal(t.estimate, null);
});

// ---- e-mails say the same as the page ---------------------------------------------------------------------

test("refund e-mails carry the timeline, the breakdown and the UTR", () => {
  const data = { orderNumber: "ARD-1", amount: 1129.45, method: "to your UPI ID de****@bank", shipping: 49, codFee: 30.45, timeline: REFUND_WINDOW_TEXT, estimatedBy: "2026-11-18", reference: "UTR123" };
  const processing = TEMPLATES.return_refund_processing(data);
  assert.match(processing.text, /1,129\.45/);
  assert.match(processing.text, /Shipping refunded/);
  assert.match(processing.text, /COD handling fee refunded/);
  assert.match(processing.text, /5.7 working days/);
  const completed = TEMPLATES.return_refund_completed(data);
  assert.match(completed.text, /UTR123/);
  assert.match(completed.text, /COD handling fee refunded/);
  const inspected = TEMPLATES.return_inspected({ orderNumber: "ARD-1", refundable: true, timeline: REFUND_WINDOW_TEXT });
  assert.match(inspected.text, /5.7 working days/);
  // a change-of-mind refund shows no shipping / fee lines
  const plain = TEMPLATES.return_refund_processing({ orderNumber: "ARD-1", amount: 1050, shipping: 0, codFee: 0, timeline: REFUND_WINDOW_TEXT });
  assert.doesNotMatch(plain.text, /Shipping refunded|COD handling fee refunded/);
});
