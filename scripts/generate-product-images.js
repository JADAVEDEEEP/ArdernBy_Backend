// Generates 4 AI product images (front, back, detail, on-model) for products that have none, uploads them to
// the existing Cloudinary folder and inserts rows into the existing product_images table (no new columns).
//
//   node scripts/generate-product-images.js                -> dry run (lists what it would generate)
//   node scripts/generate-product-images.js --apply        -> generate + attach (skips products that already have images)
//   node scripts/generate-product-images.js --apply --force            -> regenerate; only AI images from image-log.json are replaced
//   node scripts/generate-product-images.js --apply --only=slug,slug2  -> limit to some products
//   node scripts/generate-product-images.js --apply --hero             -> also generate the homepage hero
//   node scripts/generate-product-images.js --apply --shots=front      -> only the front shot (the rest can be added later)
//
// Needs GEMINI_API_KEY (or OPENAI_API_KEY) in the backend .env. Every image, prompt and failure is logged to scripts/image-log.json.
require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { connect } = require("./backup-catalogue");
const svc = require("../services/image-generation.service");
const { NEW_PRODUCTS, slugify } = require("./catalogue-data");

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const HERO = process.argv.includes("--hero");
const SHOTS = (arg("shots") || svc.SHOTS.join(",")).split(",").filter((x) => svc.SHOTS.includes(x));
const ONLY = (arg("only") || "").split(",").filter(Boolean);
const catalogueSlugs = new Set(NEW_PRODUCTS.map((p) => slugify(p.name)));

async function generateHero() {
  const prompt =
    "Editorial streetwear campaign photo, wide landscape, a young Indian man in an oversized heavyweight off-white t-shirt and black relaxed pants, " +
    "minimal concrete urban setting, overcast natural light, dark moody tones, subject on the right third with empty space on the left for text, " +
    "premium fashion campaign look, no text, no logos, no brand labels";
  const png = await svc.generateImage({ prompt, size: "1536x1024" });
  const { url } = await svc.uploadPng(png);
  const heroUrl = url.replace("c_fill,g_auto,ar_4:5,w_1200", "c_fill,g_auto,ar_16:9,w_2000");
  svc.logImage({ slug: "__hero__", shot: "hero", url: heroUrl, prompt, ai: true });
  const assets = path.join(__dirname, "..", "..", "ArdenBy", "components", "home", "home-assets.ts");
  let src = fs.readFileSync(assets, "utf8");
  src = src.replace(/export const HERO_IMAGE = '[^']*';/, `export const HERO_IMAGE = '${heroUrl}';`);
  fs.writeFileSync(assets, src);
  console.log("Hero generated and set in home-assets.ts:", heroUrl);
}

async function main() {
  if (APPLY && !svc.hasKey()) {
    console.error("No image API key: add HF_TOKEN (free), GEMINI_API_KEY or OPENAI_API_KEY to ArdenBy_Backend/.env, then re-run.");
    process.exit(2);
  }
  const conn = await connect();
  const [products] = await conn.query(
    "SELECT p.id, p.slug, p.name, p.fit, p.fabric, p.coverage, p.category_label, (SELECT COUNT(*) FROM product_images i WHERE i.product_id = p.id) AS n FROM products p ORDER BY p.created_at DESC"
  );
  const targets = products.filter((p) => {
    if (ONLY.length && !ONLY.includes(p.slug)) return false;
    if (!catalogueSlugs.has(p.slug)) return false; // existing real-photo products are never touched
    return FORCE || Number(p.n) === 0;
  });
  console.log(`${targets.length} product(s) to ${APPLY ? "generate" : "generate (dry run)"}:`);
  targets.forEach((p) => console.log(`  ${p.slug} (${p.n} existing images)`));
  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply (needs GEMINI_API_KEY or OPENAI_API_KEY).");
    await conn.end();
    return;
  }

  const failed = [];
  for (const p of targets) {
    console.log(`\n== ${p.slug}`);
    try {
      const artwork = await svc.generateArtwork(p);
      const made = [];
      for (const shot of SHOTS) {
        const r = await svc.generateShot(p, shot, { artwork });
        made.push(r.url);
        console.log(`  ${shot}: ok${r.flagged.length ? ` (flagged: ${r.flagged.join("; ")})` : ""}`);
      }
      await conn.beginTransaction();
      if (FORCE) {
        // Only AI images (listed in image-log.json) are replaced; real photos are never deleted.
        const [rows] = await conn.query("SELECT id, image_url FROM product_images WHERE product_id = ?", [p.id]);
        for (const r of rows) if (svc.isAiUrl(r.image_url)) await conn.query("DELETE FROM product_images WHERE id = ?", [r.id]);
      }
      const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?", [p.id]);
      let pos = Number(n);
      for (const url of made) {
        await conn.query(
          "INSERT INTO product_images (id, product_id, image_url, sort_order, is_primary, created_at) VALUES (?, ?, ?, ?, ?, NOW())",
          [crypto.randomUUID(), p.id, url, pos, pos === 0 ? 1 : 0]
        );
        pos += 1;
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      console.error(`  FAILED: ${err.message}`);
      failed.push(p.slug);
      if (err.status === 401 || err.status === 403) break;
    }
  }
  if (HERO) await generateHero().catch((e) => { console.error("Hero failed:", e.message); failed.push("__hero__"); });
  console.log(`\nDone. ${targets.length - failed.length} succeeded, ${failed.length} failed${failed.length ? ": " + failed.join(", ") : ""}.`);
  await conn.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
