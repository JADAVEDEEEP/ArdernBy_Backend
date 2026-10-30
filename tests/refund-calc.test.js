const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const calc = require(path.join(__dirname, "..", "services", "refund-calc.service.js"));
const { calculateOrderTotals } = require(path.join(__dirname, "..", "utils", "pricing.js"));

const ORDER = (over = {}) => ({
  subtotal: 1000, discount_amount: 100, tax_amount: 45, shipping_amount: 0, total_amount: 945, ...over,
});
const LINES = [
  { id: "a", product_name: "Tee", quantity: 2, unit_price: 300 },
  { id: "b", product_name: "Cap", quantity: 1, unit_price: 400 },
];

test("largest remainder splits always add up to the total", () => {
  for (const [total, weights] of [[100, [1, 1, 1]], [7, [3, 3, 3]], [1, [5, 5]], [0, [1, 2]], [999, [60000, 40000, 1]]]) {
    const parts = calc.largestRemainder(total, weights);
    assert.equal(parts.reduce((a, b) => a + b, 0), total, JSON.stringify([total, weights]));
    assert.ok(parts.every((p) => p >= 0));
  }
  assert.deepEqual(calc.largestRemainder(10, [0, 0]), [0, 0]);
});

test("a line's total = gross - its share of the discount + its share of GST", () => {
  const lines = calc.allocate(ORDER(), LINES);
  assert.equal(lines[0].grossPaise, 60000);
  assert.equal(lines[1].grossPaise, 40000);
  assert.equal(lines[0].discountPaise + lines[1].discountPaise, 10000);
  assert.equal(lines[0].taxPaise + lines[1].taxPaise, 4500);
  assert.equal(lines[0].totalPaise, 60000 - 6000 + 2700);
  assert.equal(lines[1].totalPaise, 40000 - 4000 + 1800);
  assert.equal(lines.reduce((s, l) => s + l.totalPaise, 0), 94500, "the goods the customer paid for");
});

test("refunding everything gives back exactly what was paid for the goods (+ shipping only when asked)", () => {
  const order = ORDER({ shipping_amount: 79, total_amount: 1024 });
  const all = [{ orderItemId: "a", quantity: 2, offset: 0 }, { orderItemId: "b", quantity: 1, offset: 0 }];
  const noShip = calc.computeRefund({ order, lines: LINES, picks: all });
  assert.equal(noShip.final, 945);
  const ship = calc.computeRefund({ order, lines: LINES, picks: all, includeShipping: true });
  assert.equal(ship.final, 1024, "equals the order total");
  assert.equal(ship.remainingAfter, 0);
});

test("a partial refund is the item's share, never the whole order", () => {
  const one = calc.computeRefund({ order: ORDER(), lines: LINES, picks: [{ orderItemId: "a", quantity: 1, offset: 0 }] });
  assert.equal(one.final, 283.5, "half of 594 for one of two tees");
  assert.ok(one.final < 945);
  assert.deepEqual(one.lines[0], {
    orderItemId: "a", name: "Tee", quantity: 1, goods: 300, discount: 30, tax: 13.5, refund: 283.5, refundPaise: 28350,
  });
});

test("separate partial refunds of one line add up to exactly the line total (no paisa lost or invented)", () => {
  const first = calc.computeRefund({ order: ORDER(), lines: LINES, picks: [{ orderItemId: "a", quantity: 1, offset: 0 }] });
  const second = calc.computeRefund({
    order: ORDER(), lines: LINES, picks: [{ orderItemId: "a", quantity: 1, offset: 1 }], alreadyRefundedPaise: first.finalPaise,
  });
  assert.equal(first.finalPaise + second.finalPaise, 56700, "600 - 60 discount + 27 GST");
  assert.throws(
    () => calc.computeRefund({ order: ORDER(), lines: LINES, picks: [{ orderItemId: "a", quantity: 1, offset: 2 }] }),
    (e) => e.code === "QUANTITY_UNAVAILABLE"
  );
});

test("randomised: any way of splitting any order into partial refunds adds up exactly and never exceeds what was paid", () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 300; round += 1) {
    const lineCount = 1 + rnd(4);
    const lines = Array.from({ length: lineCount }, (_, i) => ({
      id: `l${i}`, product_name: `P${i}`, quantity: 1 + rnd(5), unit_price: (199 + rnd(2500)) / 1 + rnd(100) / 100,
    }));
    const subtotal = Math.round(lines.reduce((s, l) => s + l.unit_price * l.quantity, 0) * 100) / 100;
    const coupon = rnd(3) === 0 ? 0 : Math.round(subtotal * (rnd(30) / 100) * 100) / 100;
    const t = calculateOrderTotals(subtotal, coupon);
    const order = {
      subtotal: t.subtotal, discount_amount: t.discountAmount, tax_amount: t.taxAmount, shipping_amount: t.shippingAmount, total_amount: t.totalAmount,
    };
    const goods = Math.round((t.subtotal - t.discountAmount + t.taxAmount) * 100);

    // refund one unit at a time in a random order
    const units = lines.flatMap((l) => Array.from({ length: l.quantity }, () => l.id));
    for (let i = units.length - 1; i > 0; i -= 1) { const j = rnd(i + 1); [units[i], units[j]] = [units[j], units[i]]; }
    const used = {};
    let refunded = 0;
    units.forEach((lineId, index) => {
      const last = index === units.length - 1;
      const r = calc.computeRefund({
        order, lines, picks: [{ orderItemId: lineId, quantity: 1, offset: used[lineId] || 0 }],
        includeShipping: last, alreadyRefundedPaise: refunded,
      });
      used[lineId] = (used[lineId] || 0) + 1;
      refunded += r.finalPaise;
      assert.ok(refunded <= Math.round(order.total_amount * 100), "never more than paid");
    });
    // Rounding in subtotal (unit prices with paise) can differ from the sum of lines by a few paise at most.
    assert.ok(Math.abs(refunded - (goods + Math.round(t.shippingAmount * 100))) <= 5 * lines.length, `round ${round}: ${refunded} vs ${goods}`);
  }
});

test("a deduction can only reduce the refund, never raise it", () => {
  const base = calc.computeRefund({ order: ORDER(), lines: LINES, picks: [{ orderItemId: "b", quantity: 1, offset: 0 }] });
  const less = calc.computeRefund({ order: ORDER(), lines: LINES, picks: [{ orderItemId: "b", quantity: 1, offset: 0 }], deductionPaise: 5000 });
  assert.equal(less.final, base.final - 50);
  for (const bad of [-1, base.calculatedPaise + 1]) {
    assert.throws(() => calc.computeRefund({ order: ORDER(), lines: LINES, picks: [{ orderItemId: "b", quantity: 1, offset: 0 }], deductionPaise: bad }), (e) => e.code === "BAD_DEDUCTION");
  }
});

test("a refund can never exceed what remains of the amount paid", () => {
  assert.throws(
    () => calc.computeRefund({ order: ORDER(), lines: LINES, picks: [{ orderItemId: "b", quantity: 1, offset: 0 }], alreadyRefundedPaise: 94000 }),
    (e) => e.code === "EXCEEDS_PAID"
  );
});

test("bad selections are refused", () => {
  const run = (picks) => () => calc.computeRefund({ order: ORDER(), lines: LINES, picks });
  assert.throws(run([]), (e) => e.code === "NO_ITEMS");
  assert.throws(run([{ orderItemId: "zzz", quantity: 1 }]), (e) => e.code === "UNKNOWN_ITEM");
  assert.throws(run([{ orderItemId: "a", quantity: 0 }]), (e) => e.code === "BAD_QUANTITY");
  assert.throws(run([{ orderItemId: "a", quantity: 1.5 }]), (e) => e.code === "BAD_QUANTITY");
  assert.throws(run([{ orderItemId: "a", quantity: 3 }]), (e) => e.code === "QUANTITY_UNAVAILABLE");
  assert.throws(run([{ orderItemId: "a", quantity: 1 }, { orderItemId: "a", quantity: 1 }]), (e) => e.code === "DUPLICATE_ITEM");
});

test("commitments: cancelled and returned units are counted, rejected returns are not, earlier-only offsets work", async () => {
  const rows = {
    cancelled: [{ order_item_id: "a", quantity: 1 }],
    cancelRefunds: [{ refund_amount: "100.00" }],
    returns: [
      { id: "r1", status: "Requested", refund_status: null, refund_amount: null, created_at: 1 },
      { id: "r2", status: "Approved", refund_status: "completed", refund_amount: "50.00", created_at: 2 },
    ],
    items: [{ return_id: "r1", order_item_id: "a", quantity: 1 }, { return_id: "r2", order_item_id: "b", quantity: 1 }],
  };
  const executor = {
    async execute(sql) {
      if (sql.includes("FROM order_cancellation_items")) return [rows.cancelled];
      if (sql.includes("FROM order_cancellations")) return [rows.cancelRefunds];
      if (sql.includes("FROM return_requests")) {
        assert.ok(sql.includes("<> 'Rejected'"), "rejected returns are excluded");
        return [rows.returns];
      }
      if (sql.includes("FROM return_request_items")) return [rows.items];
      throw new Error(sql);
    },
  };
  const c = await calc.loadCommitments(executor, "o1", LINES);
  assert.equal(c.refundedPaise, 15000);
  assert.equal(calc.committedUnits(c, "a", { all: true }), 2, "1 cancelled + 1 in r1");
  assert.equal(calc.committedUnits(c, "a", { beforeReturnId: "r1" }), 1, "r1 only sees the cancellation");
  assert.equal(calc.committedUnits(c, "b", { beforeReturnId: "r2" }), 0);
  assert.equal(calc.committedUnits(c, "b", { all: true }), 1);
});

test("commitments degrade to 'nothing committed' while the tables do not exist yet", async () => {
  const executor = { async execute() { const e = new Error("no table"); e.code = "ER_NO_SUCH_TABLE"; throw e; } };
  const c = await calc.loadCommitments(executor, "o1", LINES);
  assert.equal(c.refundedPaise, 0);
  assert.equal(c.returns.length, 0);
});
