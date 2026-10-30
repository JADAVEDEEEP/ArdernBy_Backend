// Product create / edit / delete: stock changes land in the inventory history
// and important changes land in the audit trail. Runs the REAL product service
// against an in-memory stand-in for MySQL.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

process.env.RAZORPAY_KEY_ID = "rzp_test_unit";
process.env.RAZORPAY_KEY_SECRET = "unit_secret";

const root = path.join(__dirname, "..");
const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

const state = {};
const reset = () => {
  state.product = {
    id: "p1", slug: "tee", name: "Tee", category_slug: "tees", price: 999, mrp: 1299, best_price: 999,
    inventory: 10, best_seller: 0, new_arrival: 0, trending: 0, limited_edition: 0,
  };
  state.variants = [
    { id: "v1", size: "M", color: "Black", inventory: 5 },
    { id: "v2", size: "L", color: "Black", inventory: 8 },
  ];
  state.movements = [];
  state.audit = [];
};
reset();

const run = async (sql, p = []) => {
  const t = norm(sql);

  if (t.startsWith("select slug, name, category_slug, price, mrp, best_price, inventory")) {
    return [state.product ? [{ ...state.product }] : []];
  }
  if (t.startsWith("select id from products where id = ?")) return [[{ id: "p1" }]];
  if (t.startsWith("update products set")) {
    Object.assign(state.product, { slug: p[0], name: p[1], price: p[7], mrp: p[8], best_price: p[9], inventory: p[20] });
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("select id, size, color, inventory from product_variants")) {
    return [state.variants.map((v) => ({ ...v }))];
  }
  if (t.startsWith("update product_variants set size = ?")) {
    state.variants.find((v) => v.id === p[4]).inventory = p[2];
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("insert into product_variants")) {
    state.variants.push({ id: p[0], size: p[2], color: p[3], inventory: p[4] });
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("select 1 from order_items where variant_id")) return [[]];
  if (t.startsWith("delete from product_variants")) {
    state.variants = state.variants.filter((v) => v.id !== p[0]);
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("insert ignore into inventory_movements")) {
    const key = p[11];
    if (key && state.movements.some((m) => m.dedupe_key === key)) return [{ affectedRows: 0 }];
    state.movements.push({
      product_id: p[1], variant_id: p[2], previous: p[3], next: p[4], delta: p[5], reason: p[6],
      source: p[7], actor: p[10], dedupe_key: key,
    });
    return [{ affectedRows: 1 }];
  }
  if (t.startsWith("insert ignore into audit_logs")) {
    state.audit.push({ actor_id: p[1], action: p[4], resource_id: p[6], before: p[9], after: p[10] });
    return [{ affectedRows: 1 }];
  }
  // getProductBySlug
  if (t.includes("from products where slug = ?")) return [[{ id: "p1", slug: p[0], name: "Tee" }]];
  if (t.includes("from product_images")) return [[]];
  if (t.includes("from product_variants where product_id = ? order by")) return [[]];
  if (t.startsWith("select 1 from product_variants pv") || t.includes("from product_variants pv")) return [[]];
  if (t.includes("from product_images where product_id")) return [[]];
  if (t.startsWith("delete from")) return [{ affectedRows: 1 }];
  if (t.startsWith("select id from products where id = ? limit 1")) return [[{ id: "p1" }]];

  throw new Error(`product-inventory-history fake DB: unhandled SQL: ${t}`);
};

const pool = { execute: run, query: run };
const sqlPath = require.resolve(path.join(root, "config", "sql.js"));
require.cache[sqlPath] = {
  id: sqlPath,
  filename: sqlPath,
  loaded: true,
  exports: { poolPromise: Promise.resolve(pool), testDatabaseConnection: async () => {} },
};

const productService = require(path.join(root, "services", "product.service.js"));
const actor = { id: "admin-1", email: "a@example.com", role: "admin", ip: "1.1.1.1" };

test.beforeEach(reset);

const baseEdit = (over = {}) => ({
  slug: "tee",
  name: "Tee",
  category_slug: "tees",
  category_label: "Tees",
  price: 999,
  mrp: 1299,
  best_price: 999,
  inventory: 10,
  variants: [
    { id: "v1", size: "M", color: "Black", inventory: 5 },
    { id: "v2", size: "L", color: "Black", inventory: 8 },
  ],
  ...over,
});

test("editing stock records previous, new, difference, reason and who", async () => {
  await productService.updateProduct(
    "p1",
    baseEdit({
      variants: [
        { id: "v1", size: "M", color: "Black", inventory: 12 },
        { id: "v2", size: "L", color: "Black", inventory: 8 },
      ],
    }),
    [],
    actor
  );

  assert.equal(state.movements.length, 1, "only the variant that changed is recorded");
  const move = state.movements[0];
  assert.equal(move.variant_id, "v1");
  assert.equal(move.previous, 5);
  assert.equal(move.next, 12);
  assert.equal(move.delta, 7);
  assert.equal(move.source, "admin_edit");
  assert.equal(move.actor, "admin-1");
  assert.ok(move.reason.length > 3);
});

test("saving a product with no stock change records no inventory history", async () => {
  await productService.updateProduct("p1", baseEdit(), [], actor);
  assert.equal(state.movements.length, 0);
});

test("price change is audited with before and after values only for what changed", async () => {
  await productService.updateProduct("p1", baseEdit({ price: 1099 }), [], actor);
  const entry = state.audit.find((a) => a.action === "product.update");
  assert.ok(entry);
  assert.equal(entry.actor_id, "admin-1");
  assert.equal(entry.resource_id, "p1");
  assert.match(entry.before, /"price":999/);
  assert.match(entry.after, /"price":1099/);
  assert.ok(!entry.after.includes('"name"'), "unchanged fields are not logged");
});

test("a new size/colour and a removed one are both recorded", async () => {
  await productService.updateProduct(
    "p1",
    baseEdit({
      variants: [
        { id: "v1", size: "M", color: "Black", inventory: 5 },
        { size: "XL", color: "Black", inventory: 4 },
      ],
    }),
    [],
    actor
  );

  const added = state.movements.find((m) => m.source === "initial_stock");
  assert.equal(added.previous, 0);
  assert.equal(added.next, 4);
  const removed = state.movements.find((m) => m.variant_id === "v2");
  assert.equal(removed.previous, 8);
  assert.equal(removed.next, 0);
});

test("deleting a product is audited with what it was", async () => {
  await productService.deleteProduct("p1", actor);
  const entry = state.audit.find((a) => a.action === "product.delete");
  assert.ok(entry);
  assert.match(entry.before, /"name":"Tee"/);
});

test("the service still works when no actor is given (existing callers)", async () => {
  await productService.updateProduct("p1", baseEdit({ price: 1100 }), []);
  assert.equal(state.audit.length, 0);
  assert.equal(state.movements.length, 0);
});
