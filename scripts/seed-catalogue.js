// Adds the 16 new products and corrects the 4 existing ones, using ONLY the existing tables/columns
// (categories, products, product_variants). No schema change. Idempotent: matched by slug / SKU.
//
//   node scripts/seed-catalogue.js           -> dry run: prints what would change, writes nothing
//   node scripts/seed-catalogue.js --apply   -> backs up the catalogue tables, then applies in ONE transaction
//
// Existing rows are only UPDATED for the fields named in the brief (collection, category tag, fit, GSM,
// flags, name, and placeholder copy). Prices, variants, images, orders and carts are not touched.
// New products are never overwritten if the slug already exists.
require("dotenv").config();
const crypto = require("crypto");
const { backupCatalogue, connect } = require("./backup-catalogue");
const {
  COLLECTIONS, CATEGORY_TAG, SIZES, PLUS_SIZES, EXISTING, NEW_PRODUCTS, NEWEST_CODES, slugify, WASH_COTTON,
} = require("./catalogue-data");

const APPLY = process.argv.includes("--apply");
const ALL_CAT_TAGS = Object.values(CATEGORY_TAG);
const slugToName = Object.fromEntries(Object.entries(COLLECTIONS).map(([n, s]) => [s, n]));

const hash = (s) => parseInt(crypto.createHash("md5").update(s).digest("hex").slice(0, 8), 16);
const stockFor = (slug, size) => {
  const h = hash(`${slug}:${size}`);
  return h % 7 === 0 ? 0 : (h % 35) + 6; // a few sold-out sizes, otherwise 6-40
};
const newId = () =>
  "ard-" + crypto.randomBytes(8).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);

function mergeTags(existing, categories) {
  const tokens = String(existing || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !ALL_CAT_TAGS.includes(t.toLowerCase()));
  for (const t of categories.map((c) => CATEGORY_TAG[c])) if (!tokens.includes(t)) tokens.push(t);
  return tokens.join(", ");
}

async function main() {
  const conn = await connect();
  const log = (m) => console.log(m);
  log(`Target: ${process.env.DB_HOST}:${process.env.DB_PORT} / ${process.env.DB_NAME}  (${APPLY ? "APPLY" : "dry run"})`);

  const [cats] = await conn.query("SELECT slug, name FROM categories");
  const catSlugs = new Set(cats.map((c) => c.slug));
  for (const slug of [...Object.values(COLLECTIONS), ...ALL_CAT_TAGS]) {
    if (!catSlugs.has(slug)) log(`! categories row missing: ${slug} (would INSERT)`);
  }
  const [skuRows] = await conn.query("SELECT sku FROM product_variants");
  const usedSkus = new Set(skuRows.map((r) => r.sku));

  const plan = { updates: [], inserts: [], skipped: [] };

  // ---- existing products -------------------------------------------------
  for (const e of EXISTING) {
    const [[row]] = await conn.query("SELECT * FROM products WHERE slug = ?", [e.slug]);
    if (!row) {
      plan.skipped.push(`${e.slug} (not found)`);
      continue;
    }
    const fd =
      e.fabricDetails ||
      (/\bGSM\b/i.test(row.fabric_details || "")
        ? row.fabric_details
        : `${(row.fabric_details || "").trim()} ${e.gsm} GSM.`.trim());
    const patch = {
      name: e.name || row.name,
      category_slug: COLLECTIONS[e.collection],
      category_label: e.collection,
      fit: e.fit,
      description: e.description || row.description,
      fabric_details: fd,
      wash_care: e.washCare || row.wash_care,
      tags: e.tags || mergeTags(row.tags, e.categories),
      limited_edition: e.flags.limited,
      best_seller: e.flags.bestSeller,
      new_arrival: e.flags.isNew,
    };
    plan.updates.push({ id: row.id, slug: e.slug, patch, before: row });
  }

  // ---- new products ------------------------------------------------------
  const base = Date.now();
  const stamp = (code, i) => {
    const n = NEWEST_CODES.indexOf(code);
    // the newest 8 get the latest timestamps (in list order); the rest sit a few days earlier
    return new Date(n >= 0 ? base - (NEWEST_CODES.length - n) * 60_000 : base - 3 * 86_400_000 + i * 60_000);
  };
  let i = 0;
  for (const p of NEW_PRODUCTS) {
    i += 1;
    const slug = slugify(p.name);
    const [[hit]] = await conn.query("SELECT id FROM products WHERE slug = ?", [slug]);
    if (hit) {
      plan.skipped.push(`${slug} (already exists)`);
      continue;
    }
    const colorCode = p.color.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
    const sizes = p.plus ? PLUS_SIZES : SIZES;
    const variants = sizes.map((size) => {
      let sku = `${p.code}-${colorCode}-${size}`;
      let n = 1;
      while (usedSkus.has(sku)) sku = `${p.code}-${colorCode}-${size}-${++n}`;
      usedSkus.add(sku);
      return { size, color: p.color, inventory: stockFor(slug, size), sku };
    });
    if (variants.every((v) => v.inventory === 0)) variants[0].inventory = 12;
    const total = variants.reduce((s, v) => s + v.inventory, 0);
    const isNew = NEWEST_CODES.includes(p.code) ? 1 : 0;
    const tagWords = [p.collection.toLowerCase(), p.type, p.fit.toLowerCase(), "streetwear", p.color.toLowerCase()];
    plan.inserts.push({
      slug,
      product: {
        id: newId(),
        slug,
        name: p.name,
        category_slug: COLLECTIONS[p.collection],
        category_label: p.collection,
        fit: p.fit,
        fabric: p.fabric,
        coverage: p.coverage,
        price: p.price,
        mrp: p.mrp,
        best_price: p.price,
        rating: 0,
        review_count: 0,
        description: p.desc,
        fabric_details: `${p.gsm ? `${p.gsm} GSM ` : ""}${p.fabric}. Pre-shrunk and finished for a consistent fit.`,
        wash_care: p.wash || WASH_COTTON,
        tags: mergeTags(tagWords.join(", "), p.categories),
        best_seller: p.bestSeller,
        new_arrival: isNew,
        trending: 0,
        limited_edition: p.limited,
        inventory: total,
        created_at: stamp(p.code, i),
        updated_at: stamp(p.code, i),
      },
      variants,
    });
  }

  // ---- report ------------------------------------------------------------
  log(`\nUpdate ${plan.updates.length} existing, insert ${plan.inserts.length} new, skip ${plan.skipped.length}`);
  for (const u of plan.updates) {
    const diff = Object.entries(u.patch)
      .filter(([k, v]) => String(u.before[k] ?? "") !== String(v ?? ""))
      .map(([k]) => k);
    log(`  UPDATE ${u.slug}: ${diff.join(", ") || "(no change)"}`);
  }
  for (const n of plan.inserts) {
    log(`  INSERT ${n.slug}  ${n.product.category_label}  Rs${n.product.price}  ${n.variants.length} sizes, stock ${n.product.inventory}`);
  }
  for (const s of plan.skipped) log(`  SKIP   ${s}`);

  if (!APPLY) {
    log("\nDry run only. Re-run with --apply to write.");
    await conn.end();
    return;
  }

  const file = await backupCatalogue(conn);
  log(`\nBackup written: ${file}`);

  await conn.beginTransaction();
  try {
    for (const slug of [...Object.values(COLLECTIONS), ...ALL_CAT_TAGS]) {
      if (!catSlugs.has(slug)) {
        const names = { ...slugToName, "top-wear": "Top Wear", "bottom-wear": "Bottom Wear", "plus-size": "Plus Size" };
        await conn.query("INSERT INTO categories (slug, name, description, created_at) VALUES (?, ?, '', NOW())", [slug, names[slug]]);
      }
    }
    // Rename the placeholder collection (slug unchanged, so URLs/orders/carts keep working) + tidy descriptions.
    await conn.query("UPDATE categories SET name = 'Kovenik Premium' WHERE slug = 'ardenby-premium'");
    await conn.query("UPDATE categories SET description = 'Tees, shirts and hoodies' WHERE slug = 'top-wear'");
    await conn.query("UPDATE categories SET description = 'Cargos, jeans, trousers and joggers' WHERE slug = 'bottom-wear'");
    await conn.query("UPDATE categories SET description = 'Cut properly for 3XL to 5XL' WHERE slug = 'plus-size'");

    for (const u of plan.updates) {
      const cols = Object.keys(u.patch);
      await conn.query(
        `UPDATE products SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = NOW() WHERE id = ?`,
        [...cols.map((c) => u.patch[c]), u.id]
      );
    }
    for (const n of plan.inserts) {
      const cols = Object.keys(n.product);
      await conn.query(
        `INSERT INTO products (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        cols.map((c) => n.product[c])
      );
      for (const v of n.variants) {
        await conn.query(
          "INSERT INTO product_variants (id, product_id, size, color, inventory, sku, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())",
          [crypto.randomUUID(), n.product.id, v.size, v.color, v.inventory, v.sku]
        );
      }
    }
    await conn.commit();
    log("\nCommitted.");
  } catch (err) {
    await conn.rollback();
    log(`\nRolled back: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
