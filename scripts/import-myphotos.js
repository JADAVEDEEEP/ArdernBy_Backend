// Imports the products photographed in ArdenBy_Backend/myphotos into the EXISTING tables
// (products, product_images). No schema change.
//
//   node scripts/import-myphotos.js           -> dry run: prints the plan, writes nothing (no uploads)
//   node scripts/import-myphotos.js --apply   -> backs up the catalogue, uploads images to Cloudinary,
//                                                inserts everything in ONE transaction
//
// Deliberately NOT invented (the photos don't say): prices, sizes, stock, fabric. So:
//  * price / mrp / best_price are NOT NULL in the schema -> stored as 0.00 (placeholder, set real prices in admin)
//  * no product_variants rows are created (variants need a size) -> products show as unavailable until
//    sizes + stock are added in admin; the colour is kept in tags/description until then
//  * fabric / coverage are NOT NULL -> stored as ''
// Idempotent: a product is skipped if its id, slug or its KVK code tag already exists.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { backupCatalogue, connect } = require("./backup-catalogue");
const { slugify } = require("./catalogue-data");

const APPLY = process.argv.includes("--apply");
const PHOTOS = path.join(__dirname, "..", "myphotos");

const PREMIUM = { slug: "ardenby-premium", label: "Kovenik Premium" };
const TOP = { slug: "top-wear", label: "Top Wear" };
const BOTTOM = { slug: "bottom-wear", label: "Bottom Wear" };

// folder, code prefix, product type, fit, default listing group
const GROUPS = {
  polo: { dir: "Oversize Polo", prefix: "KVK_POLO_", type: "Oversized Polo", tag: "polo", fit: "Oversized", cat: TOP },
  tee: { dir: "Oversize Round Neck", prefix: "KVK_", type: "Oversized T-Shirt", tag: "t-shirt", fit: "Oversized", cat: TOP },
  vip: { dir: "Oversize Round neck Primium", prefix: "KVK_VIP_", type: "Oversized T-Shirt", tag: "t-shirt", fit: "Oversized", cat: PREMIUM, extra: "kovenik premium" },
  trouser: { dir: "Trousers", prefix: "KVK_TT_", type: "Relaxed Trousers", tag: "trousers", fit: "Relaxed", cat: BOTTOM },
};

// [group, number, design (what is printed), colour as seen in the photos]
const CATALOGUE = [
  ["polo", 101, "Dragon", "Dark Brown & Cream"], ["polo", 102, "Mount Fuji", "Dark Brown & Cream"],
  ["polo", 103, "Angel", "Cream & Green"], ["polo", 104, "Crane", "Burgundy & Cream"],
  ["polo", 105, "Mountain Sun", "Teal & Cream"], ["polo", 106, "Samurai", "Purple & Cream"],
  ["polo", 107, "Dragon & Roses", "Black & Cream"], ["polo", 108, "Winged Angel", "Cream & Green"],
  ["polo", 109, "Koi", "Cream & Brown"], ["polo", 110, "Crane & Waves", "Black & Cream"],

  ["tee", 101, "Lightning Logo", "Black"], ["tee", 102, "Tokyo Tiger", "Off-White"],
  ["tee", 103, "Oni Mask", "Black"], ["tee", 104, "Racing Club", "Green"],
  ["tee", 105, "Astronaut", "Purple"], ["tee", 106, "Racing Club", "Black"],
  ["tee", 107, "Tiger Crest", "Maroon"], ["tee", 108, "Torii Sakura", "Maroon"],
  ["tee", 109, "Field Club", "Green"], ["tee", 110, "Moth", "Washed Purple"],

  ["vip", 101, "Dragon Guardian", "Black"], ["vip", 102, "Kinetic Lotus", "Beige"],
  ["vip", 103, "Stag", "Green"], ["vip", 104, "Renaissance", "Cream"],
  ["vip", 105, "Lunar Explorer", "Maroon"], ["vip", 106, "Motorsports", "Black"],
  ["vip", 107, "Botanical Lily", "Beige"], ["vip", 108, "Expedition", "Washed Olive"],
  ["vip", 109, "Collegiate", "Navy"],

  ["trouser", 101, "Eclipse Moth", "Plum"], ["trouser", 102, "Shadow Dragon", "Black"],
  ["trouser", 103, "Crane Dynasty", "Cream"], ["trouser", 104, "Mountain Moon", "Green"],
  ["trouser", 105, "Serpent Mark", "Charcoal"],
];

function buildPlan() {
  return CATALOGUE.map(([g, num, design, color]) => {
    const grp = GROUPS[g];
    const code = `${grp.prefix}${num}`; // e.g. KVK_POLO_101
    const codeTag = code.toLowerCase().replace(/_/g, "-"); // kvk-polo-101
    const name = `${design} ${grp.type}`;
    const files = fs
      .readdirSync(path.join(PHOTOS, grp.dir))
      .filter((f) => new RegExp(`^${code}_\\d+\\.png$`).test(f))
      .sort();
    if (!files.length) throw new Error(`no photos found for ${code}`);
    const tags = [grp.extra, grp.tag, grp.fit.toLowerCase(), "streetwear", color.toLowerCase(), codeTag, grp.cat === BOTTOM ? "bottom-wear" : "top-wear"]
      .filter(Boolean);
    return {
      id: `ard-${codeTag}`, slug: slugify(`${name} ${color} ${num}`), code, codeTag, name, color, grp, tags: [...new Set(tags)].join(", "),
      description: `${design} ${grp.type.toLowerCase()} in ${color.toLowerCase()}. KOVENIK.`,
      files: files.map((f) => ({ file: path.join(PHOTOS, grp.dir, f), base: path.basename(f, ".png") })),
    };
  });
}

async function main() {
  const conn = await connect();
  const log = console.log;
  log(`Target: ${process.env.DB_HOST}:${process.env.DB_PORT} / ${process.env.DB_NAME}  (${APPLY ? "APPLY" : "dry run"})`);

  const plan = buildPlan();
  const [cats] = await conn.query("SELECT slug FROM categories");
  const catSlugs = new Set(cats.map((c) => c.slug));
  for (const p of plan) if (!catSlugs.has(p.grp.cat.slug)) throw new Error(`category ${p.grp.cat.slug} missing in categories table`);

  const todo = [];
  for (const p of plan) {
    const [hit] = await conn.query(
      "SELECT id FROM products WHERE id = ? OR slug = ? OR FIND_IN_SET(?, REPLACE(tags, ' ', '')) > 0 LIMIT 1",
      [p.id, p.slug, p.codeTag]
    );
    if (hit.length) log(`  SKIP   ${p.code}  (already exists as ${hit[0].id})`);
    else todo.push(p);
  }
  log(`\n${plan.length} products in catalogue, ${todo.length} to insert, ${plan.length - todo.length} already present`);
  for (const p of todo) log(`  INSERT ${p.code.padEnd(14)} ${p.name} - ${p.color}  [${p.grp.cat.label}]  ${p.files.length} images  -> /product/${p.slug}`);

  if (!APPLY || !todo.length) {
    if (!APPLY) log("\nDry run only. Re-run with --apply to write.");
    await conn.end();
    return;
  }

  log(`\nBackup written: ${await backupCatalogue(conn)}`);

  // Upload first (deterministic public_ids + overwrite:false => re-running never duplicates files).
  const cloudinary = require("../config/cloudinary");
  for (const p of todo) {
    p.images = [];
    for (const f of p.files) {
      const r = await cloudinary.uploader.upload(f.file, {
        folder: "ardenby/products", public_id: f.base.toLowerCase(), overwrite: false, unique_filename: false, resource_type: "image",
      });
      p.images.push(r.secure_url);
      log(`  uploaded ${f.base} -> ${r.secure_url}`);
    }
  }

  await conn.beginTransaction();
  try {
    for (const p of todo) {
      await conn.query(
        `INSERT INTO products (id, slug, name, category_slug, category_label, fit, fabric, coverage, price, mrp, best_price,
           rating, review_count, description, fabric_details, wash_care, tags, best_seller, new_arrival, trending, limited_edition, inventory)
         VALUES (?, ?, ?, ?, ?, ?, '', '', 0, 0, 0, 0, 0, ?, NULL, NULL, ?, 0, 0, 0, 0, 0)`,
        [p.id, p.slug, p.name, p.grp.cat.slug, p.grp.cat.label, p.grp.fit, p.description, p.tags]
      );
      for (let i = 0; i < p.images.length; i++) {
        await conn.query(
          "INSERT INTO product_images (id, product_id, image_url, sort_order, is_primary) VALUES (?, ?, ?, ?, ?)",
          [crypto.randomUUID(), p.id, p.images[i], i, i === 0 ? 1 : 0]
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

module.exports = { CATALOGUE, GROUPS, buildPlan };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
