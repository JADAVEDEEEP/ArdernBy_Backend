-- KOVENIK seller-fault returns: remember what part of a refund was shipping / COD fee.
-- Additive, nullable, no data changes. Re-run safe via scripts/apply-seller-fault-migration.js.
-- Statements are separated by a line containing only "-- ;;".

-- 1 = the return was refunded as the seller's fault (shipping + COD fee included).
ALTER TABLE return_requests ADD COLUMN refund_seller_fault TINYINT NULL;
-- ;;
-- Rupees of the original shipping charge included in this refund.
ALTER TABLE return_requests ADD COLUMN refund_shipping DECIMAL(10,2) NULL;
-- ;;
-- Rupees of the COD handling fee (plus its GST) included in this refund.
ALTER TABLE return_requests ADD COLUMN refund_cod_fee DECIMAL(10,2) NULL;
