-- KOVENIK COD refunds by UPI payout (RazorpayX): additive columns on return_requests.
-- No drops, no data changes. Re-run safe via scripts/apply-cod-payout-migration.js
-- (it skips columns that already exist). Statements separated by a line "-- ;;".

-- The customer's UPI ID, asked on the COD return form. Shown in full to admins only.
ALTER TABLE return_requests ADD COLUMN refund_upi_id VARCHAR(100) NULL;
-- ;;
ALTER TABLE return_requests ADD COLUMN payout_contact_id VARCHAR(40) NULL;
-- ;;
ALTER TABLE return_requests ADD COLUMN payout_fund_account_id VARCHAR(40) NULL;
-- ;;
-- RazorpayX payout id (pout_...). Unique: one payout can belong to only one return.
ALTER TABLE return_requests ADD COLUMN payout_id VARCHAR(40) NULL;
-- ;;
ALTER TABLE return_requests ADD UNIQUE KEY UQ_return_payout_id (payout_id);
-- ;;
-- Bank reference (UTR) once the payout is processed.
ALTER TABLE return_requests ADD COLUMN payout_utr VARCHAR(40) NULL;
-- ;;
-- RazorpayX's own status: queued | pending | processing | processed | failed | reversed | rejected | cancelled
ALTER TABLE return_requests ADD COLUMN payout_status VARCHAR(20) NULL;
-- ;;
ALTER TABLE return_requests ADD COLUMN payout_failure_reason VARCHAR(300) NULL;
-- ;;
-- Part of the idempotency key: a new attempt (after a CONFIRMED failure) gets a new number.
ALTER TABLE return_requests ADD COLUMN payout_attempts INT NOT NULL DEFAULT 0;
-- ;;
ALTER TABLE return_requests ADD COLUMN payout_initiated_at DATETIME(6) NULL;
-- ;;
ALTER TABLE return_requests ADD COLUMN payout_completed_at DATETIME(6) NULL;
