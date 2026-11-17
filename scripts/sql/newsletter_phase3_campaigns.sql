-- KOVENIK newsletter, phase 3: campaigns, reusable templates, per-recipient delivery records, provider events.
--
-- ADDITIVE ONLY: four NEW tables (CREATE TABLE IF NOT EXISTS). No existing table, column or row is
-- touched. The only foreign keys point at the newsletter tables created by newsletter_phase1.sql
-- (newsletter_subscribers) or at tables created here. It is safe to run more than once.
--
-- REQUIRES newsletter_phase1.sql to be applied first (newsletter_subscribers must exist).
--
--   node scripts/apply-newsletter-campaigns-migration.js            -> dry run, changes nothing
--   node scripts/apply-newsletter-campaigns-migration.js --apply    -> creates the tables
--
-- Until it is applied, every campaign / template route answers 503 "not available" and nothing else is affected.
-- All dates are UTC. Profile ids are stored as plain text (no foreign key into existing tables).

-- 1. Reusable email designs --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS newsletter_templates (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  subject     VARCHAR(200) NULL,
  preheader   VARCHAR(200) NULL,
  blocks_json MEDIUMTEXT   NOT NULL,                  -- the block list (validated JSON)
  style_json  TEXT         NOT NULL,                  -- fonts / colours (validated JSON)
  created_by  VARCHAR(36)  NULL,
  updated_by  VARCHAR(36)  NULL,
  created_at  DATETIME(6)  NOT NULL,
  updated_at  DATETIME(6)  NOT NULL,
  UNIQUE KEY uq_newsletter_template_name (name)
);

-- 2. Campaigns ---------------------------------------------------------------------------
--    status: draft | scheduled | sending | sent | partially_failed | failed | cancelled
--    audience_type: all_active | selected | source   (always intersected with status = 'active' at send time)
--    html_snapshot / text_snapshot: the rendered e-mail, frozen when sending starts
--    locked_by / locked_until: a short lease so two workers can never process one campaign at once
CREATE TABLE IF NOT EXISTS newsletter_campaigns (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name             VARCHAR(120) NOT NULL,
  subject          VARCHAR(200) NOT NULL DEFAULT '',
  preheader        VARCHAR(200) NOT NULL DEFAULT '',
  blocks_json      MEDIUMTEXT   NOT NULL,
  style_json       TEXT         NOT NULL,
  status           VARCHAR(20)  NOT NULL DEFAULT 'draft',
  audience_type    VARCHAR(16)  NOT NULL DEFAULT 'all_active',
  audience_source  VARCHAR(24)  NULL,
  audience_ids     TEXT         NULL,                 -- JSON array of subscriber ids (audience_type = selected)
  scheduled_at     DATETIME(6)  NULL,
  started_at       DATETIME(6)  NULL,
  completed_at     DATETIME(6)  NULL,
  cancelled_at     DATETIME(6)  NULL,
  html_snapshot    MEDIUMTEXT   NULL,
  text_snapshot    MEDIUMTEXT   NULL,
  total_recipients INT UNSIGNED NOT NULL DEFAULT 0,
  error_note       VARCHAR(255) NULL,
  locked_by        VARCHAR(40)  NULL,
  locked_until     DATETIME(6)  NULL,
  created_by       VARCHAR(36)  NULL,
  updated_by       VARCHAR(36)  NULL,
  sent_by          VARCHAR(36)  NULL,
  created_at       DATETIME(6)  NOT NULL,
  updated_at       DATETIME(6)  NOT NULL,
  KEY ix_newsletter_campaign_status (status, scheduled_at),
  KEY ix_newsletter_campaign_created (created_at)
);

-- 3. One row per campaign + subscriber: the delivery record AND the send queue -----------
--    status: queued | sending | sent | failed | skipped
--    UNIQUE (campaign_id, subscriber_id): a subscriber can never be queued twice for a campaign.
--    unsub_token_hash: SHA-256 of the unsubscribe token placed in THIS e-mail (to count unsubscribes per campaign)
CREATE TABLE IF NOT EXISTS newsletter_campaign_recipients (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  campaign_id      BIGINT UNSIGNED NOT NULL,
  subscriber_id    BIGINT UNSIGNED NOT NULL,
  status           VARCHAR(12)  NOT NULL DEFAULT 'queued',
  attempts         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at  DATETIME(6)  NULL,
  claimed_at       DATETIME(6)  NULL,
  sent_at          DATETIME(6)  NULL,
  delivered_at     DATETIME(6)  NULL,                 -- only from provider webhooks
  bounced_at       DATETIME(6)  NULL,                 -- only from provider webhooks
  error_kind       VARCHAR(16)  NULL,                 -- temporary | permanent | interrupted | not_active | cancelled | bounced
  last_error       VARCHAR(200) NULL,
  message_id       VARCHAR(190) NULL,
  unsub_token_hash CHAR(64)     NULL,
  created_at       DATETIME(6)  NOT NULL,
  updated_at       DATETIME(6)  NOT NULL,
  UNIQUE KEY uq_newsletter_recipient (campaign_id, subscriber_id),
  KEY ix_newsletter_recipient_queue (campaign_id, status, next_attempt_at),
  KEY ix_newsletter_recipient_sent (sent_at),
  KEY ix_newsletter_recipient_unsub (unsub_token_hash),
  CONSTRAINT fk_newsletter_recipient_campaign FOREIGN KEY (campaign_id)
    REFERENCES newsletter_campaigns (id) ON DELETE CASCADE,
  CONSTRAINT fk_newsletter_recipient_subscriber FOREIGN KEY (subscriber_id)
    REFERENCES newsletter_subscribers (id) ON DELETE CASCADE
);

-- 4. Provider (Brevo) webhook events, de-duplicated ---------------------------------------
--    Only delivery events are used. Open / click events are ignored on purpose: SMTP gives no reliable tracking.
--    event_key = SHA-256 of tag + e-mail + event + timestamp, so a repeated webhook call is recorded once.
--    No e-mail address is stored here.
CREATE TABLE IF NOT EXISTS newsletter_events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  campaign_id BIGINT UNSIGNED NULL,
  recipient_id BIGINT UNSIGNED NULL,
  event       VARCHAR(24)  NOT NULL,
  event_key   CHAR(64)     NOT NULL,
  occurred_at DATETIME(6)  NULL,
  created_at  DATETIME(6)  NOT NULL,
  UNIQUE KEY uq_newsletter_event_key (event_key),
  KEY ix_newsletter_event_campaign (campaign_id, event)
);
