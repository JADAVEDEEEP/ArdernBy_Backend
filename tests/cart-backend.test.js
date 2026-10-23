const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  createFakeDb,
  installFakePool,
  callController,
  seedCatalog,
} = require("./helpers/fake-db");

const root = path.join(__dirname, "..");
const { db, pool } = createFakeDb();
installFakePool(root, pool);

const cartController = require("../controller/cart.controller");
const couponController = require("../controller/coupon.controller");
const { calculateOrderTotals, calculateCouponDiscount } = require("../utils/pricing");

const A = { id: "userA" };
const B = { id: "userB" };

test.beforeEach(() => {
  db.carts.length = 0;
  db.cart_items.length = 0;
  db.products.length = 0;
  db.variants.length = 0;
  db.coupons.length = 0;
  seedCatalog(db);
});

const add = (user, variant, quantity = 1) =>
  callController(cartController.addCartItem, {
    user,
    body: { product_id: db.variants.find((v) => v.id === variant).product_id, variant_id: variant, quantity },
  });

const itemFor = (user, variant) => {
  const cart = db.carts.find((c) => c.user_id === user.id);
  return db.cart_items.find((i) => i.cart_id === cart.id && i.variant_id === variant);
};

test("stock is enforced per variant when adding (existing + new)", async () => {
  for (const variant of db.variants) {
    for (let n = 1; n <= variant.inventory; n++) {
      const res = await add(A, variant.id, 1);
      assert.equal(res.status, 200, `${variant.id} unit ${n} should fit`);
    }
    const over = await add(A, variant.id, 1);
    assert.equal(over.status, 400);
    assert.equal(over.body.message, "Insufficient variant inventory.");
    assert.equal(itemFor(A, variant.id).quantity, variant.inventory);
  }
});

test("stock is enforced on quantity update, and invalid quantities are rejected", async () => {
  await add(A, "v1", 1);
  const item = itemFor(A, "v1");
  const inventory = db.variants.find((v) => v.id === "v1").inventory;

  const ok = await callController(cartController.updateCartItem, {
    user: A, params: { itemId: item.id }, body: { quantity: inventory },
  });
  assert.equal(ok.status, 200);

  const over = await callController(cartController.updateCartItem, {
    user: A, params: { itemId: item.id }, body: { quantity: inventory + 1 },
  });
  assert.equal(over.status, 400);
  assert.equal(over.body.message, "Insufficient variant inventory.");
  assert.equal(itemFor(A, "v1").quantity, inventory);

  for (const bad of [0, -2, 1.5, "abc"]) {
    const res = await callController(cartController.updateCartItem, {
      user: A, params: { itemId: item.id }, body: { quantity: bad },
    });
    assert.equal(res.status, 400, `quantity ${bad} must be rejected`);
  }
});

test("guest stock check applies the same variant rule as add/update", async () => {
  for (const variant of db.variants) {
    for (const quantity of [1, variant.inventory, variant.inventory + 1]) {
      const guest = await callController(cartController.checkStock, {
        body: { items: [{ product_id: variant.product_id, variant_id: variant.id, quantity }] },
      });
      assert.equal(guest.status, 200);
      assert.equal(guest.body.ok, quantity <= variant.inventory);
      assert.equal(guest.body.items[0].available, variant.inventory);
    }
  }

  const unknown = await callController(cartController.checkStock, {
    body: { items: [{ product_id: "p1", variant_id: "nope", quantity: 1 }] },
  });
  assert.equal(unknown.status, 400);
});

test("a user cannot touch another user's cart item", async () => {
  await add(A, "v3", 2);
  const item = itemFor(A, "v3");
  const res = await callController(cartController.updateCartItem, {
    user: B, params: { itemId: item.id }, body: { quantity: 1 },
  });
  assert.equal(res.status, 400);
  assert.equal(itemFor(A, "v3").quantity, 2);
});

test("coupon is stored per account and never shared between carts", async () => {
  await add(A, "v1", 1);
  await add(B, "v3", 3);
  const apply = await callController(cartController.updateCartCoupon, {
    user: A, body: { coupon_code: "save10" },
  });
  assert.equal(apply.status, 200);

  const cartA = await callController(cartController.getCart, { user: A });
  const cartB = await callController(cartController.getCart, { user: B });
  assert.equal(cartA.body.cart.coupon_code, "SAVE10");
  assert.equal(cartB.body.cart.coupon_code, null);
});

test("coupon response totals match order totals (GST once, no double count)", async () => {
  const scenarios = [
    { lines: [["v1", 1]], code: "SAVE10" },
    { lines: [["v1", 2], ["v3", 3]], code: "SAVE10" },
    { lines: [["v1", 2], ["v3", 3]], code: "FLAT200" },
    { lines: [["v1", 3]], code: "FLAT200" },
  ];

  for (const { lines, code } of scenarios) {
    db.carts.length = 0;
    db.cart_items.length = 0;
    for (const [variant, qty] of lines) await add(A, variant, qty);

    const res = await callController(cartController.updateCartCoupon, {
      user: A, body: { coupon_code: code },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // Independent expectation derived from the seeded data.
    const subtotal = lines.reduce(
      (sum, [variant, qty]) => sum + db.products.find((p) => p.id === db.variants.find((v) => v.id === variant).product_id).price * qty, 0);
    const coupon = db.coupons.find((c) => c.code === code);
    const discount = Math.min(
      coupon.discount_type === "percentage"
        ? Math.min((subtotal * coupon.discount_value) / 100, coupon.max_discount ?? Infinity)
        : coupon.discount_value,
      subtotal
    );
    const shipping = subtotal >= 999 ? 0 : 79;
    const gst = Math.round((subtotal - discount) * 0.05);

    assert.equal(res.body.subtotal, subtotal);
    assert.equal(res.body.discount, discount);
    assert.equal(res.body.shipping, shipping);
    assert.equal(res.body.tax, gst);
    assert.equal(res.body.total, subtotal - discount + shipping + gst);
    assert.deepEqual(
      calculateOrderTotals(subtotal, calculateCouponDiscount(coupon, subtotal)).totalAmount,
      res.body.total
    );
  }
});

test("coupon validation rejects expired coupons, low subtotals and bad subtotals", async () => {
  const expired = await callController(couponController.validateCoupon, { body: { code: "OLD", subtotal: 1000 } });
  assert.equal(expired.status, 400);
  const low = await callController(couponController.validateCoupon, { body: { code: "SAVE10", subtotal: 100 } });
  assert.equal(low.status, 400);
  for (const subtotal of [undefined, "abc", 0, -5]) {
    const bad = await callController(couponController.validateCoupon, { body: { code: "SAVE10", subtotal } });
    assert.equal(bad.status, 400, `subtotal ${subtotal} must be rejected`);
  }
});

test("clearing the cart also clears its coupon", async () => {
  await add(A, "v1", 2);
  await callController(cartController.updateCartCoupon, { user: A, body: { coupon_code: "SAVE10" } });
  assert.equal(db.carts[0].coupon_code, "SAVE10");

  const res = await callController(cartController.clearCart, { user: A });
  assert.equal(res.status, 200);
  assert.equal(db.carts[0].coupon_code, null);
  assert.equal(db.cart_items.length, 0);
});

test("removing a coupon resets it to null", async () => {
  await add(A, "v1", 2);
  await callController(cartController.updateCartCoupon, { user: A, body: { coupon_code: "SAVE10" } });
  await callController(cartController.updateCartCoupon, { user: A, body: { coupon_code: null } });
  assert.equal(db.carts[0].coupon_code, null);
});
