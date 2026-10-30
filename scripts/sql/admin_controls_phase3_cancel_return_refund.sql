-- KOVENIK admin controls, phase 3: cancellations, return lifecycle, refunds.
--
-- ADDITIVE and safe to run more than once:
--   * 5 new tables (CREATE TABLE IF NOT EXISTS)
--   * new COLUMNS on the two return tables that THIS project created in phase 1/2
--     (return_requests, return_request_items). Each ALTER only runs when its
--     sentinel column is missing, so a second run changes nothing.
--   * one index swap on return_requests (unique-per-order -> plain index) so a
--     customer may return different items of one order in separate requests.
-- No order, payment, product, customer or other existing-table data is touched.
-- Apply AFTER phase 1 and phase 2, BEFORE deploying the matching backend.

-- 1. Cancellations (customer / admin / system), one row per cancellation ---------
CREATE TABLE IF NOT EXISTS order_cancellations (
  id                   CHAR(36)      NOT NULL PRIMARY KEY,
  order_id             VARCHAR(64)   NOT NULL,
  user_id              VARCHAR(64)   NULL,
  initiated_by         VARCHAR(10)   NOT NULL,        -- customer | admin | system
  actor_id             VARCHAR(64)   NULL,
  reason_code          VARCHAR(40)   NOT NULL,
  reason_note          VARCHAR(500)  NULL,
  whole_order          TINYINT       NOT NULL DEFAULT 0,
  refund_amount        DECIMAL(10,2) NULL,
  refund_status        VARCHAR(20)   NOT NULL DEFAULT 'not_applicable',
                       -- not_applicable | pending | processing | completed | failed
  refund_id            VARCHAR(64)   NULL,
  refund_error         VARCHAR(300)  NULL,
  refund_completed_at  DATETIME(6)   NULL,
  created_at           DATETIME(6)   NOT NULL,
  updated_at           DATETIME(6)   NOT NULL,
  KEY ix_cancel_order (order_id, created_at),
  KEY ix_cancel_created (created_at),
  KEY ix_cancel_refund (refund_status),
  KEY ix_cancel_refund_id (refund_id)
);

CREATE TABLE IF NOT EXISTS order_cancellation_items (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  cancellation_id CHAR(36)      NOT NULL,
  order_item_id   VARCHAR(64)   NOT NULL,
  variant_id      VARCHAR(64)   NULL,
  quantity        INT           NOT NULL,
  line_refund     DECIMAL(10,2) NULL,
  UNIQUE KEY uq_cancel_item (cancellation_id, order_item_id),
  KEY ix_cancel_item_line (order_item_id)
);

-- 2. Return status history -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS return_status_history (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  return_id   CHAR(36)     NOT NULL,
  from_status VARCHAR(20)  NULL,
  to_status   VARCHAR(20)  NOT NULL,
  actor_id    VARCHAR(64)  NULL,
  actor_role  VARCHAR(20)  NULL,
  note        VARCHAR(500) NULL,
  created_at  DATETIME(6)  NOT NULL,
  KEY ix_rsh_return (return_id, created_at)
);

-- 3. Customer e-mails already sent (prevents duplicates on retries / webhooks) --------
CREATE TABLE IF NOT EXISTS notification_log (
  dedupe_key VARCHAR(190) NOT NULL PRIMARY KEY,
  recipient  VARCHAR(254) NOT NULL,
  template   VARCHAR(60)  NOT NULL,
  status     VARCHAR(10)  NOT NULL,                  -- sending | sent | failed
  error      VARCHAR(200) NULL,
  created_at DATETIME(6)  NOT NULL,
  updated_at DATETIME(6)  NOT NULL,
  KEY ix_notify_created (created_at)
);

-- 3b. When an order was marked Delivered (starts the return window). The orders table has
--     no delivered-at column and is not altered; orders delivered before this table
--     existed fall back to their last update time.
CREATE TABLE IF NOT EXISTS order_delivery_log (
  order_id     VARCHAR(64) NOT NULL PRIMARY KEY,
  delivered_at DATETIME(6) NOT NULL,
  recorded_by  VARCHAR(64) NULL,
  KEY ix_delivery_at (delivered_at)
);

-- 4. New columns on the return tables (guarded: only if not there yet) ---------------
SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.columns
               WHERE table_schema = DATABASE() AND table_name = 'return_requests' AND column_name = 'reason_code');
SET @sql := IF(@needs,
  'ALTER TABLE return_requests
     ADD COLUMN reason_code            VARCHAR(40)   NULL,
     ADD COLUMN description            VARCHAR(1000) NULL,
     ADD COLUMN tracking_reference     VARCHAR(100)  NULL,
     ADD COLUMN shipped_at             DATETIME(6)   NULL,
     ADD COLUMN inspected_by           VARCHAR(64)   NULL,
     ADD COLUMN inspected_at           DATETIME(6)   NULL,
     ADD COLUMN refund_calculated      DECIMAL(10,2) NULL,
     ADD COLUMN refund_deduction       DECIMAL(10,2) NULL,
     ADD COLUMN refund_deduction_reason VARCHAR(500) NULL,
     ADD COLUMN refund_method          VARCHAR(20)   NULL,
     ADD COLUMN refund_reference       VARCHAR(100)  NULL,
     ADD COLUMN refund_processed_by    VARCHAR(64)   NULL,
     ADD COLUMN refund_completed_at    DATETIME(6)   NULL,
     ADD COLUMN refund_error           VARCHAR(300)  NULL,
     ADD COLUMN completed_at           DATETIME(6)   NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @needs := (SELECT COUNT(*) = 0 FROM information_schema.columns
               WHERE table_schema = DATABASE() AND table_name = 'return_request_items' AND column_name = 'inspection_result');
SET @sql := IF(@needs,
  'ALTER TABLE return_request_items
     ADD COLUMN inspection_result   VARCHAR(30)   NULL,
     ADD COLUMN inspection_note     VARCHAR(500)  NULL,
     ADD COLUMN refundable          TINYINT       NULL,
     ADD COLUMN restock             TINYINT       NULL,
     ADD COLUMN restock_authorized  TINYINT       NOT NULL DEFAULT 0,
     ADD COLUMN restocked_at        DATETIME(6)   NULL,
     ADD COLUMN line_refund         DECIMAL(10,2) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 5. One request per order -> many per order (item-level checks replace it) ----------
SET @has_unique := (SELECT COUNT(*) > 0 FROM information_schema.statistics
                    WHERE table_schema = DATABASE() AND table_name = 'return_requests' AND index_name = 'uq_return_order');
SET @sql := IF(@has_unique,
  'ALTER TABLE return_requests DROP INDEX uq_return_order, ADD INDEX ix_return_order (order_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
