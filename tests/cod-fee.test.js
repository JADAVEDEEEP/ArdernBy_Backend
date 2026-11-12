const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const pricing = require("../utils/pricing");
const { calculateOrderTotals } = pricing;

// ---- pure pricing -------------------------------------------------------------------

const cod = (subtotal, discount = 0) => calculateOrderTotals(subtotal, discount, { cod: true });
const prepaid = (subtotal, discount = 0) => calculateOrderTotals(subtotal, discount);

test("COD adds a flat 29 handling fee plus 5% GST on the fee; prepaid never does", () => {
  const c = cod(1000);
  assert.equal(c.codFee, 29);
  assert.equal(c.codFeeTax, 1.45);
  // 1000 goods + 49 shipping + 50 GST + 29 fee + 1.45 fee GST
  assert.equal(c.totalAmount, 1129.45);
  // the goods GST is untouched, so refunds (which allocate tax_amount) never include the fee
  assert.equal(c.taxAmount, 50);

  const p = prepaid(1000);
  assert.equal(p.codFee, 0);
  assert.equal(p.codFeeTax, 0);
  assert.equal(p.totalAmount, 1099);
});

test("COD fee is added for cart values 999, 2500 and 3000", () => {
  for (const value of [999, 2500, 3000]) {
    assert.ok(pricing.isCodAllowed(value), `${value} allowed`);
    const c = cod(value);
    assert.equal(c.codFee, 29);
    assert.equal(c.totalAmount, prepaid(value).totalAmount + 30.45);
  }
});

test("COD is not allowed above 3000 (the fee is not part of the limit)", () => {
  assert.equal(pricing.isCodAllowed(3000), true);
  assert.equal(pricing.isCodAllowed(3000.01), false);
  assert.equal(pricing.isCodAllowed(3001), false);
  assert.equal(pricing.COD_LIMIT_MESSAGE, "COD is available only for orders up to ₹3,000. Please choose online payment.");
});

test("the limit looks at the goods after the coupon, so a coupon can bring a cart back under it", () => {
  const t = cod(3100, 200);
  assert.equal(t.taxableAmount, 2900);
  assert.ok(pricing.isCodAllowed(t.taxableAmount));
});

test("an empty cart has no COD fee", () => {
  assert.equal(cod(0).codFee, 0);
});

// ---- createOrder against a scripted connection ----------------------------------------

const sqlModule = path.resolve(__dirname, "../config/sql.js");
const inserts = [];

const makeConnection = (price, quantity) => ({
  beginTransaction: async () => {},
  commit: async () => {},
  rollback: async () => {},
  release: () => {},
  execute: async (sql, params) => {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.startsWith("select id, coupon_code from carts")) return [[{ id: "cart1", coupon_code: null }]];
    if (q.includes("from cart_items ci")) {
      return [[{ id: "ci1", variant_id: "v1", quantity, price_snapshot: price, product_id: "p1", product_name: "Shirt", product_mrp: price, product_image: null, size: "M", color: "Black", inventory: 50 }]];
    }
    if (q.startsWith("insert into orders")) inserts.push({ sql: q, params });
    if (q.startsWith("update product_variants")) return [{ affectedRows: 1 }];
    return [{ affectedRows: 1 }];
  },
});

let connection;
require.cache[sqlModule] = {
  id: sqlModule,
  filename: sqlModule,
  loaded: true,
  exports: { poolPromise: Promise.resolve({ getConnection: async () => connection, execute: async () => [[]] }) },
};

const membership = require("../services/membership.service");
membership.priceLines = async (_c, _u, lines) => ({ member: null, unitPrices: lines.map((l) => Number(l.price)), maxTotalDiscountPercent: null });
const history = require("../services/inventory-history.service");
history.recordVariantDelta = async () => {};
const orders = require("../services/order.service");

const place = async (price, quantity, paymentMethod) => {
  connection = makeConnection(price, quantity);
  inserts.length = 0;
  return orders.createOrder({
    userId: "u1",
    paymentMethod,
    shippingAddress: { name: "A", phone: "9999999999", pincode: "110001", address: "x", city: "y", state: "z" },
  });
};

test("COD order: fee stored, total includes it", async () => {
  const order = await place(1000, 1, "cod");
  assert.equal(order.codFee, 29);
  assert.equal(order.codFeeTax, 1.45);
  assert.equal(order.totalAmount, 1129.45);
  assert.equal(inserts.length, 1);
  assert.ok(inserts[0].params.includes(29) && inserts[0].params.includes(1.45));
});

test("COD at exactly 3000 is accepted (total 3000 + 49 + 150 + 30.45)", async () => {
  const order = await place(3000, 1, "cod");
  assert.equal(order.codFee, 29);
  assert.equal(order.totalAmount, 3229.45);
});

test("COD at 3001 is refused by the server and nothing is inserted", async () => {
  await assert.rejects(() => place(3001, 1, "cod"), (error) => {
    assert.equal(error.code, "COD_LIMIT_EXCEEDED");
    assert.equal(error.message, pricing.COD_LIMIT_MESSAGE);
    return true;
  });
  assert.equal(inserts.length, 0);
});

test("a prepaid order over 3000 is fine and carries no COD fee", async () => {
  const order = await place(3001, 1, "online");
  assert.equal(order.codFee, 0);
  assert.equal(order.codFeeTax, 0);
  assert.equal(order.totalAmount, 3001 + 49 + 150);
});
