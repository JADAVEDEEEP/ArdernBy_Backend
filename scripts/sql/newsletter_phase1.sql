-- KOVENIK newsletter, phase 1: subscribers + single-use e-mail tokens.
--
-- ADDITIVE ONLY: two NEW tables (CREATE TABLE IF NOT EXISTS). No existing table, column or
-- row is touched, and no foreign key points at an existing table, so it is safe to run more
-- than once. Campaign tables are NOT here; they arrive with a later phase.
--
--   node scripts/apply-newsletter-migration.js            -> dry run, changes nothing
--   node scripts/apply-newsletter-migration.js --apply    -> creates the tables
--   (or: mysql -h <host> -P <port> -u <user> -p <database> < scripts/sql/newsletter_phase1.sql)
--
-- Until it is applied, POST /api/newsletter/subscribe answers 503 "not available" and
-- nothing else in the store is affected.
--
-- All dates are UTC.

-- 1. Subscribers ---------------------------------------------------------------------
--    status: pending      = signed up, e-mail NOT yet confirmed (never receives marketing)
--            active       = confirmed (the only status marketing may be sent to)
--            unsubscribed = opted out (never mailed; stays suppressed until re-confirmed)
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email                VARCHAR(254) NOT NULL,              -- stored lower-case
  status               VARCHAR(16)  NOT NULL DEFAULT 'pending',
  source               VARCHAR(24)  NOT NULL DEFAULT 'home',
  consent_text_version VARCHAR(16)  NOT NULL,
  consent_ip_hash      CHAR(64)     NULL,                  -- HMAC of the IP, never the raw IP
  consent_user_agent   VARCHAR(255) NULL,
  subscribed_at        DATETIME(6)  NOT NULL,
  confirmation_sent_at DATETIME(6)  NULL,                  -- throttles repeat confirmation e-mails
  confirmed_at         DATETIME(6)  NULL,
  unsubscribed_at      DATETIME(6)  NULL,
  created_at           DATETIME(6)  NOT NULL,
  updated_at           DATETIME(6)  NOT NULL,
  UNIQUE KEY uq_newsletter_email (email),
  KEY ix_newsletter_status (status),
  KEY ix_newsletter_created (created_at)
);

-- 2. Tokens (only the SHA-256 hash is stored) -----------------------------------------
--    purpose: confirm (expires, single-use) | unsubscribe (used by a later phase)
CREATE TABLE IF NOT EXISTS newsletter_tokens (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  subscriber_id BIGINT UNSIGNED NOT NULL,
  purpose       VARCHAR(16)  NOT NULL,
  token_hash    CHAR(64)     NOT NULL,
  expires_at    DATETIME(6)  NULL,
  used_at       DATETIME(6)  NULL,
  created_at    DATETIME(6)  NOT NULL,
  UNIQUE KEY uq_newsletter_token_hash (token_hash),
  KEY ix_newsletter_token_subscriber (subscriber_id, purpose),
  CONSTRAINT fk_newsletter_token_subscriber FOREIGN KEY (subscriber_id)
    REFERENCES newsletter_subscribers (id) ON DELETE CASCADE
);
