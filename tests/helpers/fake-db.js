// In-memory stand-in for the MySQL pool. It answers exactly the queries issued by
// cart.service / coupon.service so the REAL service + controller code runs in tests.
const path = require("path");

const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

function createFakeDb() {
  const db = {
    carts: [],
    cart_items: [],
    products: [],
    variants: [],
    coupons: [],
  };

  const itemView = (item) => {
    const product = db.products.find((p) => p.id === item.product_id);
    return {
      ...item,
      product_name_snapshot: item.product_name_snapshot || product?.name,
    };
  };

  const rules = [
    [/from carts where user_id = \? limit 1/, (p) =>
      db.carts.filter((c) => c.user_id === p[0]).slice(0, 1)],
    [/from carts where id = \? limit 1/, (p) =>
      db.carts.filter((c) => c.id === p[0]).slice(0, 1)],
    [/^insert into carts/, (p) => {
      db.carts.push({ id: p[0], user_id: p[1], coupon_code: null });
      return { affectedRows: 1 };
    }],
    [/from products where id = \? limit 1/, (p) =>
      db.products.filter((x) => x.id === p[0])],
    [/from product_variants where id = \? and product_id = \?/, (p) =>
      db.variants.filter((v) => v.id === p[0] && v.product_id === p[1])],
    [/select inventory from product_variants where id = \?/, (p) =>
      db.variants.filter((v) => v.id === p[0])],
    [/from cart_items where cart_id = \? and product_id = \? and variant_id = \?/, (p) =>
      db.cart_items.filter(
        (i) => i.cart_id === p[0] && i.product_id === p[1] && i.variant_id === p[2]
      )],
    [/select quantity, price_snapshot from cart_items where cart_id = \?/, (p) =>
      db.cart_items.filter((i) => i.cart_id === p[0])],
    [/from cart_items ci left join products p/, (p) =>
      db.cart_items.filter((i) => i.cart_id === p[0]).map(itemView)],
    [/from cart_items ci inner join carts c .*where ci\.id = \? and c\.user_id = \?/, (p) =>
      db.cart_items.filter((i) => {
        const cart = db.carts.find((c) => c.id === i.cart_id);
        return i.id === p[0] && cart && cart.user_id === p[1];
      })],
    [/from product_images where product_id = \?/, () => []],
    [/^insert into cart_items/, (p) => {
      db.cart_items.push({
        id: p[0],
        cart_id: p[1],
        product_id: p[2],
        variant_id: p[3],
        product_name_snapshot: p[4],
        image_snapshot: p[5],
        size: p[6],
        color: p[7],
        quantity: p[8],
        price_snapshot: p[9],
        mrp_snapshot: p[10],
      });
      return { affectedRows: 1 };
    }],
    [/^update cart_items set quantity = \?,? .*where id = \?/, (p) => {
      const item = db.cart_items.find((i) => i.id === p[1]);
      if (item) item.quantity = p[0];
      return { affectedRows: item ? 1 : 0 };
    }],
    [/^delete from cart_items where id = \?/, (p) => {
      db.cart_items = db.cart_items.filter((i) => i.id !== p[0]);
      return { affectedRows: 1 };
    }],
    [/^delete from cart_items where cart_id = \?/, (p) => {
      db.cart_items = db.cart_items.filter((i) => i.cart_id !== p[0]);
      return { affectedRows: 1 };
    }],
    [/^update carts set coupon_code = null,? .*where id = \?/, (p) => {
      const cart = db.carts.find((c) => c.id === p[0]);
      if (cart) cart.coupon_code = null;
      return { affectedRows: cart ? 1 : 0 };
    }],
    [/^update carts set coupon_code = \?,? .*where id = \?/, (p) => {
      const cart = db.carts.find((c) => c.id === p[1]);
      if (cart) cart.coupon_code = p[0];
      return { affectedRows: cart ? 1 : 0 };
    }],
    [/from coupons where code = \? limit 1/, (p) =>
      db.coupons.filter((c) => c.code === p[0])],
  ];

  const pool = {
    async execute(sql, params = []) {
      const text = norm(sql);
      for (const [pattern, handler] of rules) {
        if (pattern.test(text)) {
          const result = handler(params);
          // Row sets and write results both come back as [payload].
          return [JSON.parse(JSON.stringify(result))];
        }
      }
      throw new Error(`FakeDb: unhandled SQL: ${text}`);
    },
  };

  return { db, pool };
}

// Replaces ../config/sql (which opens a real connection) with the fake pool.
function installFakePool(backendRoot, pool) {
  const sqlPath = require.resolve(path.join(backendRoot, "config", "sql"));
  require.cache[sqlPath] = {
    id: sqlPath,
    filename: sqlPath,
    loaded: true,
    exports: { poolPromise: Promise.resolve(pool) },
  };
}

// Calls an Express handler directly and captures status + JSON body.
async function callController(handler, { user, body = {}, params = {} } = {}) {
  let status = 200;
  let payload;
  const res = {
    status(code) {
      status = code;
      return res;
    },
    json(data) {
      payload = data;
      return res;
    },
  };
  await handler({ user, body, params }, res);
  return { status, body: payload };
}

function seedCatalog(db) {
  db.products.push(
    { id: "p1", name: "Oxford Shirt", price: 1000, mrp: 1500 },
    { id: "p2", name: "Linen Tee", price: 300, mrp: 400 }
  );
  db.variants.push(
    { id: "v1", product_id: "p1", size: "M", color: "Black", inventory: 3, sku: "S1" },
    { id: "v2", product_id: "p1", size: "L", color: "Black", inventory: 1, sku: "S2" },
    { id: "v3", product_id: "p2", size: "M", color: "Navy", inventory: 10, sku: "S3" }
  );
  const future = new Date(Date.now() + 86400000 * 30).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  db.coupons.push(
    { id: "c1", code: "SAVE10", discount_type: "percentage", discount_value: 10, min_order: 500, max_discount: 150, expiry: future, active: 1 },
    { id: "c2", code: "FLAT200", discount_type: "flat", discount_value: 200, min_order: 1000, max_discount: null, expiry: future, active: 1 },
    { id: "c3", code: "OLD", discount_type: "flat", discount_value: 50, min_order: 0, max_discount: null, expiry: past, active: 1 }
  );
}

module.exports = { createFakeDb, installFakePool, callController, seedCatalog };
