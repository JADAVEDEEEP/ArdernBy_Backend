// Phase 3 of the myphotos import: product-type categories for the 34 imported products (ids "ard-kvk-*").
//   Oversize Polo / Oversize Round Neck / Premium Round Neck / Trousers
// Uses ONLY existing tables: inserts 4 rows into `categories`, and adds one slug token to the `tags` of the
// 34 imported products (the shop already matches a category against category_slug OR a tag token).
// No other product is touched. Idempotent. Dry run by default.
//   node scripts/import-myphotos-categories.js [--apply]
require("dotenv").config();
const { backupCatalogue, connect } = require("./backup-catalogue");

const APPLY = process.argv.includes("--apply");
const CATEGORIES = {
  polo: { slug: "oversize-polo", name: "Oversize Polo", description: "Oversized polos with artwork front and back" },
  tee: { slug: "oversize-round-neck", name: "Oversize Round Neck", description: "Oversized round neck t-shirts" },
  vip: { slug: "premium-round-neck", name: "Premium Round Neck", description: "Premium oversized round neck t-shirts" },
  trouser: { slug: "trousers", name: "Trousers", description: "Relaxed trousers with drawstring waist" },
};
// ids look like ard-kvk-polo-101 / ard-kvk-101 (tee) / ard-kvk-vip-101 / ard-kvk-tt-101
const groupOf = (id) => (/^ard-kvk-polo-/.test(id) ? "polo" : /^ard-kvk-vip-/.test(id) ? "vip" : /^ard-kvk-tt-/.test(id) ? "trouser" : /^ard-kvk-\d+$/.test(id) ? "tee" : null);

(async () => {
  const conn = await connect();
  console.log(`Target: ${process.env.DB_HOST} / ${process.env.DB_NAME} (${APPLY ? "APPLY" : "dry run"})`);
  const [rows] = await conn.query("SELECT id, tags FROM products WHERE id LIKE 'ard-kvk-%'");
  const [cats] = await conn.query("SELECT slug FROM categories");
  const have = new Set(cats.map((c) => c.slug));

  const tagUpdates = [];
  const counts = {};
  for (const r of rows) {
    const g = groupOf(r.id);
    if (!g) throw new Error(`unrecognised imported id ${r.id}`);
    counts[g] = (counts[g] || 0) + 1;
    const tokens = String(r.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
    const slug = CATEGORIES[g].slug;
    if (!tokens.includes(slug)) tagUpdates.push({ id: r.id, tags: [...tokens, slug].join(", ") });
  }
  const newCats = Object.values(CATEGORIES).filter((c) => !have.has(c.slug));
  console.log(`imported products: ${rows.length}`, counts);
  console.log(`tag updates: ${tagUpdates.length}; category rows to insert: ${newCats.map((c) => c.slug).join(", ") || "none"}`);
  if (!APPLY) { console.log("Dry run only."); await conn.end(); return; }

  console.log("Backup:", await backupCatalogue(conn));
  await conn.beginTransaction();
  try {
    for (const c of newCats) await conn.query("INSERT INTO categories (slug, name, description, created_at) VALUES (?, ?, ?, NOW())", [c.slug, c.name, c.description]);
    for (const u of tagUpdates) await conn.query("UPDATE products SET tags = ? WHERE id = ?", [u.tags, u.id]);
    await conn.commit();
    console.log("Committed.");
  } catch (e) {
    await conn.rollback();
    console.log("Rolled back:", e.message);
    process.exitCode = 1;
  } finally { await conn.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
