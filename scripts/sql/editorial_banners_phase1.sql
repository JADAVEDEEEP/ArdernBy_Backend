-- KOVENIK banner management, phase 1.
--
-- ADDITIVE ONLY: adds nullable / defaulted columns and one index to the
-- EXISTING `editorial_banners` table. It does not drop, rename or rewrite any
-- column or row, and it creates no second banner table. Each step checks
-- information_schema first, so it is safe to run more than once.
--
--   mysql -h <host> -P <port> -u <user> -p <database> < scripts/sql/editorial_banners_phase1.sql
--   (or: node scripts/apply-banner-migration.js)
--
-- Until it is applied the public banner API answers with an empty list and the
-- admin banner screens say the database update is pending; nothing else is
-- affected.
--
-- Dates are stored in UTC.

SET @db = DATABASE();

-- link_url: where a click on the banner goes (absolute http(s) URL or a /path).
SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'editorial_banners' AND COLUMN_NAME = 'link_url'),
  'SELECT 1',
  'ALTER TABLE editorial_banners ADD COLUMN link_url VARCHAR(2048) NULL AFTER image_url');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- mobile_image_url: optional portrait artwork used on phones.
SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'editorial_banners' AND COLUMN_NAME = 'mobile_image_url'),
  'SELECT 1',
  'ALTER TABLE editorial_banners ADD COLUMN mobile_image_url VARCHAR(2048) NULL AFTER image_url');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- start_at / end_at: campaign window (UTC). NULL means "no limit" on that side.
SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'editorial_banners' AND COLUMN_NAME = 'start_at'),
  'SELECT 1',
  'ALTER TABLE editorial_banners ADD COLUMN start_at DATETIME NULL');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'editorial_banners' AND COLUMN_NAME = 'end_at'),
  'SELECT 1',
  'ALTER TABLE editorial_banners ADD COLUMN end_at DATETIME NULL');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- sort_order: lower numbers show first.
SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'editorial_banners' AND COLUMN_NAME = 'sort_order'),
  'SELECT 1',
  'ALTER TABLE editorial_banners ADD COLUMN sort_order INT NOT NULL DEFAULT 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Index for the public query (active + order).
SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'editorial_banners' AND INDEX_NAME = 'ix_banners_active_order'),
  'SELECT 1',
  'ALTER TABLE editorial_banners ADD KEY ix_banners_active_order (active, sort_order)');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
