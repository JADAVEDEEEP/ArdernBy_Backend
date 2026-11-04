-- KOVENIK membership: smallest additive migration on top of the existing
-- subscription_plans / subscription_plan_benefits / subscriptions tables.
-- No drops, no changes to existing rows. Re-runnable: the runner
-- (scripts/apply-membership-migration.js) skips anything that already exists.
-- Statements are separated by a line containing only "-- ;;".

-- Tier order for the upgrade/renewal policy (0 = not a membership tier, i.e. the legacy Free/Plus/Premium rows).
ALTER TABLE subscription_plans ADD COLUMN tier_rank INT NOT NULL DEFAULT 0;
-- ;;
-- Razorpay link + price snapshot for each purchase attempt.
ALTER TABLE subscriptions ADD COLUMN razorpay_order_id VARCHAR(100) NULL;
-- ;;
ALTER TABLE subscriptions ADD COLUMN razorpay_payment_id VARCHAR(100) NULL;
-- ;;
ALTER TABLE subscriptions ADD COLUMN amount DECIMAL(10,2) NULL;
-- ;;
-- none | created | paid | failed | refund_pending | refunded
ALTER TABLE subscriptions ADD COLUMN payment_status VARCHAR(20) NOT NULL DEFAULT 'none';
-- ;;
ALTER TABLE subscriptions ADD UNIQUE KEY UQ_subscriptions_rzp_order (razorpay_order_id);
-- ;;
ALTER TABLE subscriptions ADD UNIQUE KEY UQ_subscriptions_rzp_payment (razorpay_payment_id);
-- ;;
ALTER TABLE subscriptions ADD KEY IX_subscriptions_user_status (user_id, status, end_date);
-- ;;
-- Birthday benefit.
ALTER TABLE profiles ADD COLUMN birthday DATE NULL;
-- ;;
-- Product-wise rules. No row = eligible at the plan's discount_percent.
-- eligible = 0 excludes the product for that plan; member_price (optional) overrides the percentage.
CREATE TABLE IF NOT EXISTS membership_product_prices (
  id char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  plan_id char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  product_id varchar(100) NOT NULL,
  eligible tinyint(1) NOT NULL DEFAULT 1,
  member_price decimal(10,2) DEFAULT NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY UQ_membership_product_prices (plan_id, product_id),
  KEY IX_membership_product_prices_product (product_id),
  CONSTRAINT FK_membership_product_prices_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans (id),
  CONSTRAINT CK_membership_product_prices_price CHECK (member_price IS NULL OR member_price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
