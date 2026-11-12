// Admin image tools: list products with their images, regenerate one AI image. Uses only the existing
// products / product_images tables. Regeneration needs OPENAI_API_KEY and is admin-only (see admin.routes).
const crypto = require("crypto");
const { poolPromise } = require("../config/sql");
const svc = require("../services/image-generation.service");
const { publicMessage } = require("../utils/public-error");

const fail = (res, err) => {
  const status = err.status && err.status < 600 ? err.status : 500;
  if (status >= 500 && status !== 502 && status !== 503) return res.status(500).json({ message: publicMessage(err) });
  return res.status(status).json({ message: err.message });
};

const listProductImages = async (req, res) => {
  try {
    const pool = await poolPromise;
    const [products] = await pool.query(
      "SELECT id, slug, name, category_label FROM products ORDER BY created_at DESC"
    );
    const [images] = await pool.query(
      "SELECT id, product_id, image_url, sort_order, is_primary FROM product_images ORDER BY product_id, sort_order"
    );
    const log = svc.readLog();
    const aiUrls = new Set(log.images.map((i) => i.url));
    const byProduct = {};
    for (const img of images) {
      (byProduct[img.product_id] ||= []).push({
        id: img.id,
        url: img.image_url,
        position: img.sort_order,
        isPrimary: Boolean(img.is_primary),
        aiGenerated: aiUrls.has(img.image_url),
      });
    }
    res.json({
      canGenerate: svc.hasKey(),
      shots: svc.SHOTS,
      products: products.map((p) => ({ id: p.id, slug: p.slug, name: p.name, collection: p.category_label, images: byProduct[p.id] || [] })),
    });
  } catch (err) {
    fail(res, err);
  }
};

/** POST /api/admin/images/:productId/regenerate  { shot: front|back|detail|model, prompt?: string } */
const regenerateImage = async (req, res) => {
  try {
    const shot = String(req.body?.shot || "");
    if (!svc.SHOTS.includes(shot)) return res.status(400).json({ message: `shot must be one of ${svc.SHOTS.join(", ")}` });
    const custom = String(req.body?.prompt || "").trim().slice(0, 500) || undefined;

    const pool = await poolPromise;
    const [[product]] = await pool.query(
      "SELECT id, slug, name, fit, fabric, coverage, category_label FROM products WHERE id = ?",
      [req.params.productId]
    );
    if (!product) return res.status(404).json({ message: "Product not found" });

    const result = await svc.generateShot(product, shot, { custom });
    const position = svc.SHOTS.indexOf(shot);

    // Replace the AI image sitting at this position; real photos are never overwritten.
    const [rows] = await pool.query(
      "SELECT id, image_url FROM product_images WHERE product_id = ? AND sort_order = ?",
      [product.id, position]
    );
    const replaceable = rows.find((r) => svc.isAiUrl(r.image_url));
    if (replaceable) {
      await pool.query("UPDATE product_images SET image_url = ? WHERE id = ?", [result.url, replaceable.id]);
    } else {
      const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?", [product.id]);
      await pool.query(
        "INSERT INTO product_images (id, product_id, image_url, sort_order, is_primary, created_at) VALUES (?, ?, ?, ?, ?, NOW())",
        [crypto.randomUUID(), product.id, result.url, Number(n), Number(n) === 0 ? 1 : 0]
      );
    }
    res.json({ url: result.url, flagged: result.flagged });
  } catch (err) {
    fail(res, err);
  }
};

module.exports = { listProductImages, regenerateImage };
