-- One-off backfill: make products.inventory equal the sum of its variants.
-- The app now keeps it in sync automatically; run this once to fix old rows.
-- Safe to re-run. NOT applied automatically.
UPDATE products p
SET p.inventory = (
  SELECT COALESCE(SUM(GREATEST(pv.inventory, 0)), 0)
  FROM product_variants pv
  WHERE pv.product_id = p.id
);
