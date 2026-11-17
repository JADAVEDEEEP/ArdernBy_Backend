// Phase 2 of the myphotos import: launch prices, S/M/L/XL variants (with SKUs), PROVISIONAL opening stock,
// descriptions and a fabric placeholder for the 34 imported products (ids "ard-kvk-*"). Existing tables only.
//
//   node scripts/import-myphotos-pricing.js           -> dry run
//   node scripts/import-myphotos-pricing.js --apply   -> backup, then ONE transaction
//
// Repeatable and non-destructive - it only fills gaps, so admin edits are never overwritten:
//  * price/mrp/best_price are set only while a product's price is still 0.00
//  * description is replaced only while it is still the phase-1 placeholder
//  * fabric_details is set only while empty
//  * a variant is inserted only if (product, size, colour) or its SKU does not exist; existing stock untouched
//  * every NEW variant gets one inventory_movements row (source initial_stock) whose reason says the
//    quantity is a provisional, UNCONFIRMED assumption - visible in Admin > Stock history.
// Products are tagged "stock-unconfirmed" (visible/editable in the admin product form); remove the tag once
// the stock is physically counted. Other products are never touched.
require("dotenv").config();
const crypto = require("crypto");
const { backupCatalogue, connect } = require("./backup-catalogue");
const { buildPlan, GROUPS } = require("./import-myphotos");
const inventoryHistory = require("../services/inventory-history.service");

const APPLY = process.argv.includes("--apply");
const SIZES = ["S", "M", "L", "XL"];
const OPENING_QTY = 5;
const FABRIC_PLACEHOLDER = "Fabric details to be confirmed";
const STOCK_TAG = "stock-unconfirmed";
const LEDGER_REASON = "PROVISIONAL opening stock (assumed 5 per size) - UNCONFIRMED, not physically counted";

const PRICE = { polo: 999, tee: 799, vip: 1099, trouser: 1299 };
const GROUP_KEY = Object.fromEntries(Object.entries(GROUPS).map(([k, g]) => [g.prefix, k]));

// Descriptions written from what the photos show. No fabric, GSM or composition claims.
const DESC = {
  KVK_POLO_101: "Dark brown oversized polo with cream shoulder panels and a contrast collar. A dragon rising through waves and a red sun is printed across the front, with the KOVENIK mark on the chest and a large dragon back print.",
  KVK_POLO_102: "Dark brown oversized polo with cream shoulder panels. A clean front with the KOVENIK chest mark, and a Mount Fuji and cherry blossom artwork across the back.",
  KVK_POLO_103: "Cream oversized polo with green sleeves and collar. A classical angel statue framed by a sun halo and foliage is printed on the front and back.",
  KVK_POLO_104: "Burgundy oversized polo with cream shoulder panels. A white crane in flight against a red sun, with cherry blossom and cloud detail, on the front and back.",
  KVK_POLO_105: "Teal oversized polo with cream shoulder panels. A mountain landscape with a golden sun and pine trees is printed on the front, with a matching scene on the back.",
  KVK_POLO_106: "Purple oversized polo with cream shoulder panels. A samurai silhouette against a full moon and blossoms is printed on the front and back.",
  KVK_POLO_107: "Black oversized polo with cream shoulder panels. A dragon winding through red roses is printed across the front, with a large dragon back print.",
  KVK_POLO_108: "Cream oversized polo with green sleeves and collar. A winged angel figure in monochrome green linework is printed on the front and back.",
  KVK_POLO_109: "Cream oversized polo with brown collar and sleeves. A koi fish rising through waves under a gold sun is printed on the front and back.",
  KVK_POLO_110: "Black oversized polo with cream trim. A white crane against a red sun above rolling waves, printed on the front and back.",
  KVK_101: "Black oversized t-shirt with a small KOVENIK lightning logo and red slash on the chest. The back carries a large illustrated graphic with an orange sun and the KOVENIK wordmark.",
  KVK_102: "Off-white oversized t-shirt with a KOVENIK Tokyo logo and red sun on the chest. The back features a large tiger illustration with Japanese lettering and a pagoda scene.",
  KVK_103: "Black oversized t-shirt with a small KOVENIK logo with Japanese lettering on the chest and a red oni mask graphic on the back.",
  KVK_104: "Green oversized t-shirt with a KOVENIK Racing Club chest print and a racing car graphic across the back.",
  KVK_105: "Purple oversized t-shirt with a framed astronaut graphic on the chest and an astronaut resting on the moon across the back.",
  KVK_106: "Black oversized t-shirt with a KOVENIK Racing Club chest print and a race car and red sun graphic on the back.",
  KVK_107: "Maroon oversized t-shirt with a tiger head and red sun chest print reading KOVENIK Tokyo, and a large tiger illustration on the back.",
  KVK_108: "Maroon oversized t-shirt with a small torii gate on the chest and a mountain, pagoda and cherry blossom scene with a red sun on the back.",
  KVK_109: "Dark green oversized t-shirt with a Field Club compass emblem on the chest and a mountain scene on the back.",
  KVK_110: "Washed plum oversized t-shirt with a small moth on the chest and a large moth and moon graphic on the back.",
  KVK_VIP_101: "Black premium oversized t-shirt with a dragon coiling across the front in red and teal, with Japanese characters. Part of the Kovenik Premium collection.",
  KVK_VIP_102: "Beige premium oversized t-shirt with an ink-style lotus and gold sun, with Japanese characters. Part of the Kovenik Premium collection.",
  KVK_VIP_103: "Green premium oversized t-shirt with a stag with ornate antlers surrounded by florals. Part of the Kovenik Premium collection.",
  KVK_VIP_104: "Cream premium oversized t-shirt with a classical statue bust, gold halo, flowers and a red drape. Part of the Kovenik Premium collection.",
  KVK_VIP_105: "Maroon premium oversized t-shirt in a washed finish with an astronaut seated on the moon beside a ringed planet. Part of the Kovenik Premium collection.",
  KVK_VIP_106: "Black premium oversized t-shirt with a Motorsports Archive chest mark and a race car graphic on the back. Part of the Kovenik Premium collection.",
  KVK_VIP_107: "Beige premium oversized t-shirt with a red lily botanical illustration and the KOVENIK Botanical Archive wordmark. Part of the Kovenik Premium collection.",
  KVK_VIP_108: "Washed olive premium oversized t-shirt with a mountain Expedition Archive graphic and KOVENIK wordmark. Part of the Kovenik Premium collection.",
  KVK_VIP_109: "Navy premium oversized t-shirt in a washed finish with a KOVENIK Collegiate Archive laurel crest. Part of the Kovenik Premium collection.",
  KVK_TT_101: "Plum relaxed trousers with a drawstring waist, a KOVENIK mark at the hip and an eclipse moth graphic down the leg.",
  KVK_TT_102: "Black relaxed trousers with a drawstring waist, a KOVENIK mark at the hip and a dragon and red sun graphic down the leg.",
  KVK_TT_103: "Cream relaxed trousers with a drawstring waist, a KOVENIK mark at the hip and a crane and red sun graphic down the leg.",
  KVK_TT_104: "Green relaxed trousers with a drawstring waist, a KOVENIK mark at the hip and a mountain and moon graphic down the leg.",
  KVK_TT_105: "Charcoal relaxed trousers with a drawstring waist, a KOVENIK mark at the hip and a serpent graphic down the leg.",
};

const initials = (color) => {
  const words = color.split(/[^A-Za-z]+/).filter(Boolean);
  return (words.length === 1 ? words[0].slice(0, 3) : words.map((w) => w[0]).join("")).toUpperCase();
};

async function main() {
  const conn = await connect();
  const log = console.log;
  log(`Target: ${process.env.DB_HOST}:${process.env.DB_PORT} / ${process.env.DB_NAME}  (${APPLY ? "APPLY" : "dry run"})`);

  const plan = buildPlan();
  for (const p of plan) if (!DESC[p.code]) throw new Error(`no description for ${p.code}`);

  const work = [];
  const summary = { priced: 0, described: 0, fabric: 0, tagged: 0, newVariants: 0, keptVariants: 0, missing: 0 };
  for (const p of plan) {
    const [[row]] = await conn.query("SELECT id, price, description, fabric_details, tags FROM products WHERE id = ?", [p.id]);
    if (!row) { summary.missing++; log(`  MISSING ${p.code} (run import-myphotos.js first)`); continue; }
    const price = PRICE[GROUP_KEY[p.grp.prefix]];
    const oldPlaceholder = `${p.name.replace(` ${p.grp.type}`, "")} ${p.grp.type.toLowerCase()} in ${p.color.toLowerCase()}. KOVENIK.`;
    const tokens = String(row.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
    const item = { p, row, price };
    item.setPrice = Number(row.price) === 0;
    item.setDesc = !row.description || row.description === oldPlaceholder;
    item.setFabric = !String(row.fabric_details || "").trim();
    item.setTag = !tokens.includes(STOCK_TAG);
    item.tags = [...tokens, STOCK_TAG].join(", ");
    const [have] = await conn.query("SELECT size FROM product_variants WHERE product_id = ? AND color = ?", [p.id, p.color]);
    const haveSizes = new Set(have.map((v) => v.size));
    item.newSizes = SIZES.filter((s) => !haveSizes.has(s));
    summary.keptVariants += haveSizes.size;
    summary.newVariants += item.newSizes.length;
    summary.priced += item.setPrice; summary.described += item.setDesc; summary.fabric += item.setFabric; summary.tagged += item.setTag;
    work.push(item);
  }
  log(`\n${work.length} products found. Will set price on ${summary.priced}, description on ${summary.described}, fabric placeholder on ${summary.fabric}, tag ${summary.tagged}; insert ${summary.newVariants} variants (keep ${summary.keptVariants} existing).`);
  if (summary.missing) log(`${summary.missing} product(s) missing.`);
  for (const w of work.slice(0, 3)) log(`  e.g. ${w.p.code}: Rs${w.price}, colour "${w.p.color}", new sizes ${w.newSizes.join("/") || "none"}`);

  if (!APPLY) {
    log("\nDry run only. Re-run with --apply to write.");
    await conn.end();
    return;
  }

  const [skuRows] = await conn.query("SELECT sku FROM product_variants WHERE sku IS NOT NULL");
  const usedSkus = new Set(skuRows.map((r) => r.sku));
  log(`\nBackup written: ${await backupCatalogue(conn)}`);

  await conn.beginTransaction();
  let ledgerFailures = 0, ledgerRows = 0;
  try {
    for (const w of work) {
      const { p } = w;
      if (w.setPrice) await conn.query("UPDATE products SET price = ?, mrp = ?, best_price = ?, updated_at = NOW() WHERE id = ? AND price = 0", [w.price, w.price, w.price, p.id]);
      if (w.setDesc) await conn.query("UPDATE products SET description = ? WHERE id = ?", [DESC[p.code], p.id]);
      if (w.setFabric) await conn.query("UPDATE products SET fabric_details = ? WHERE id = ?", [FABRIC_PLACEHOLDER, p.id]);
      if (w.setTag) await conn.query("UPDATE products SET tags = ? WHERE id = ?", [w.tags, p.id]);

      for (const size of w.newSizes) {
        let sku = `${p.codeTag.toUpperCase()}-${initials(p.color)}-${size}`;
        if (usedSkus.has(sku)) throw new Error(`SKU collision: ${sku}`);
        usedSkus.add(sku);
        const variantId = crypto.randomUUID();
        await conn.query(
          "INSERT INTO product_variants (id, product_id, size, color, inventory, sku, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())",
          [variantId, p.id, size, p.color, OPENING_QTY, sku]
        );
        const ok = await inventoryHistory.record(conn, {
          productId: p.id, variantId, previous: 0, next: OPENING_QTY, reason: LEDGER_REASON,
          source: "initial_stock", referenceType: "import", referenceId: p.code, dedupeKey: `myphotos-opening:${variantId}`,
        });
        if (ok) ledgerRows++; else ledgerFailures++;
      }
      await conn.query(
        "UPDATE products SET inventory = (SELECT COALESCE(SUM(GREATEST(inventory, 0)), 0) FROM product_variants WHERE product_id = ?) WHERE id = ?",
        [p.id, p.id]
      );
    }
    if (ledgerFailures) throw new Error(`${ledgerFailures} stock-history rows failed to write; rolling back so nothing is half-recorded`);
    await conn.commit();
    log(`\nCommitted. ${summary.newVariants} variants inserted, ${ledgerRows} stock-history rows written.`);
  } catch (err) {
    await conn.rollback();
    log(`\nRolled back: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

// config/sql.js (pulled in by the inventory service) opens a pool that would keep the process alive.
main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
