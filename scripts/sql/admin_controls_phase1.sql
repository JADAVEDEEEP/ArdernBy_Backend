-- KOVENIK admin controls, phase 1.
--
-- ADDITIVE ONLY: creates new tables. It does not alter, drop or rewrite any
-- existing table or row, and it is safe to run more than once
-- (CREATE TABLE IF NOT EXISTS). Apply it to the database BEFORE deploying the
-- matching backend code, ideally on a test database first:
--
--   mysql -h <host> -P <port> -u <user> -p <database> < scripts/sql/admin_controls_phase1.sql
--
-- Until it is applied the new features answer "not available yet" or skip
-- their bookkeeping; the existing shop, orders and payments keep working.
--
-- No foreign keys on purpose: these are history/ledger tables and must never
-- block or cascade into the live shop tables.

-- 1. Audit trail ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id            CHAR(36)      NOT NULL PRIMARY KEY,
  created_at    DATETIME(6)   NOT NULL,
  actor_id      VARCHAR(64)   NULL,
  actor_email   VARCHAR(254)  NULL,
  actor_role    VARCHAR(20)   NULL,
  action        VARCHAR(64)   NOT NULL,
  resource_type VARCHAR(40)   NOT NULL,
  resource_id   VARCHAR(100)  NULL,
  outcome       VARCHAR(12)   NOT NULL DEFAULT 'success',
  reason        VARCHAR(500)  NULL,
  before_value  JSON          NULL,
  after_value   JSON          NULL,
  ip            VARCHAR(64)   NULL,
  dedupe_key    VARCHAR(190)  NULL,
  UNIQUE KEY uq_audit_dedupe (dedupe_key),
  KEY ix_audit_created (created_at),
  KEY ix_audit_actor (actor_id, created_at),
  KEY ix_audit_action (action, created_at),
  KEY ix_audit_resource (resource_type, resource_id)
);

-- 2. Inventory movements ------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_movements (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  created_at     DATETIME(6)  NOT NULL,
  product_id     VARCHAR(64)  NOT NULL,
  variant_id     VARCHAR(64)  NULL,
  previous_qty   INT          NOT NULL,
  new_qty        INT          NOT NULL,
  delta          INT          NOT NULL,
  reason         VARCHAR(200) NOT NULL,
  source         VARCHAR(30)  NOT NULL,
  reference_type VARCHAR(30)  NULL,
  reference_id   VARCHAR(64)  NULL,
  actor_id       VARCHAR(64)  NULL,
  dedupe_key     VARCHAR(190) NULL,
  UNIQUE KEY uq_inv_dedupe (dedupe_key),
  KEY ix_inv_created (created_at),
  KEY ix_inv_product (product_id, created_at),
  KEY ix_inv_variant (variant_id, created_at),
  KEY ix_inv_source (source, created_at)
);

-- 3. Review moderation (reversible; the review itself is never touched) -------
CREATE TABLE IF NOT EXISTS review_moderation (
  review_id    VARCHAR(64)  NOT NULL PRIMARY KEY,
  product_id   VARCHAR(64)  NOT NULL,
  status       VARCHAR(10)  NOT NULL,          -- 'hidden' | 'visible'
  reason       VARCHAR(500) NOT NULL,
  moderated_by VARCHAR(64)  NOT NULL,
  moderated_at DATETIME(6)  NOT NULL,
  KEY ix_rm_product (product_id, status)
);

-- 4. Return requests ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS return_requests (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  order_id        VARCHAR(64)   NOT NULL,
  user_id         VARCHAR(64)   NOT NULL,
  status          VARCHAR(20)   NOT NULL,      -- Requested | Approved | Rejected | Received
  customer_reason VARCHAR(500)  NOT NULL,
  decision_reason VARCHAR(500)  NULL,
  decided_by      VARCHAR(64)   NULL,
  decided_at      DATETIME(6)   NULL,
  received_by     VARCHAR(64)   NULL,
  received_at     DATETIME(6)   NULL,
  restocked_at    DATETIME(6)   NULL,
  refund_status   VARCHAR(20)   NULL,          -- processed | pending | queued | manual_required | not_required
  refund_id       VARCHAR(64)   NULL,
  refund_amount   DECIMAL(10,2) NULL,
  created_at      DATETIME(6)   NOT NULL,
  updated_at      DATETIME(6)   NOT NULL,
  UNIQUE KEY uq_return_order (order_id),
  KEY ix_return_status (status, created_at),
  KEY ix_return_user (user_id)
);

-- 5. Sign-out-everywhere and login history ----------------------------------------
-- A session token issued at or before revoked_before is refused.
CREATE TABLE IF NOT EXISTS session_revocations (
  user_id       VARCHAR(64) NOT NULL PRIMARY KEY,
  revoked_before BIGINT     NOT NULL,          -- unix seconds
  updated_at    DATETIME(6) NOT NULL
);

CREATE TABLE IF NOT EXISTS login_history (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  user_id    VARCHAR(64)  NOT NULL,
  method     VARCHAR(20)  NOT NULL,            -- otp | google
  ip         VARCHAR(64)  NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME(6)  NOT NULL,
  KEY ix_login_user (user_id, created_at)
);

-- 6. Fresh confirmation for role changes and admin invitations ----------------------
-- The code itself is never stored, only a keyed hash. Single use, short expiry.
CREATE TABLE IF NOT EXISTS admin_confirmations (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  action       VARCHAR(20)  NOT NULL,          -- role_change | admin_invite
  actor_id     VARCHAR(64)  NOT NULL,
  target_id    VARCHAR(64)  NULL,
  target_email VARCHAR(254) NULL,
  new_role     VARCHAR(20)  NOT NULL,
  reason       VARCHAR(500) NOT NULL,
  code_hash    CHAR(64)     NOT NULL,
  attempts     INT          NOT NULL DEFAULT 0,
  expires_at   DATETIME(6)  NOT NULL,
  used_at      DATETIME(6)  NULL,
  created_at   DATETIME(6)  NOT NULL,
  KEY ix_conf_actor (actor_id, created_at)
);
