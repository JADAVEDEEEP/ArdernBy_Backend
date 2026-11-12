-- KOVENIK cash-on-delivery handling fee: smallest additive migration.
-- Two columns on orders; existing rows default to 0 (no fee). No drops, no data changes.
-- Re-runnable: scripts/apply-cod-fee-migration.js skips what already exists.
-- Statements are separated by a line containing only "-- ;;".

-- Flat COD handling fee charged on this order (0 for prepaid orders).
ALTER TABLE orders ADD COLUMN cod_fee DECIMAL(10,2) NOT NULL DEFAULT 0;
-- ;;
-- GST charged on that fee. total_amount already includes both; neither is refundable.
ALTER TABLE orders ADD COLUMN cod_fee_tax DECIMAL(10,2) NOT NULL DEFAULT 0;
