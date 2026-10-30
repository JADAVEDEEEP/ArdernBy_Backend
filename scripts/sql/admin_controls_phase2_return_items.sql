-- KOVENIK admin controls, phase 2: which items a customer wants to return.
--
-- ADDITIVE ONLY: one new table. No existing table or row is altered, and it is
-- safe to run more than once (CREATE TABLE IF NOT EXISTS). Apply it AFTER
-- admin_controls_phase1.sql and before deploying the matching backend code.
--
-- Return requests that already exist (made before this table) have no rows
-- here; they are treated as "the whole order", exactly as before.

CREATE TABLE IF NOT EXISTS return_request_items (
  id            CHAR(36)    NOT NULL PRIMARY KEY,
  return_id     CHAR(36)    NOT NULL,
  order_item_id VARCHAR(64) NOT NULL,
  product_id    VARCHAR(64) NULL,
  variant_id    VARCHAR(64) NULL,
  quantity      INT         NOT NULL,
  UNIQUE KEY uq_return_item (return_id, order_item_id),
  KEY ix_return_items_return (return_id)
);
