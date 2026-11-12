// Moves membership to ONE plan: KOVENIK MEMBER (Rs 199 / year, flat 15% off eligible products).
//
//   node scripts/seed-membership-plans.js          -> shows what would change, changes nothing
//   node scripts/seed-membership-plans.js --apply  -> applies it (needs membership_phase1.sql applied first)
//
// What --apply does (all in one transaction):
//   1. Creates the plan "kovenik-member" and its benefit lines (skipped if the slug already exists;
//      an existing plan is never overwritten, so admin edits survive a re-run).
//   2. RETIRES the old Bronze / Silver / Gold plans by setting active = 0 only. Nothing is deleted
//      and no subscription row is touched, so purchase history stays intact and every term that is
//      already running continues until its end date (the app presents it as KOVENIK MEMBER and gives
//      it at least the new 15%, plus the free shipping an old Gold term already had).
// The legacy Free / Plus / Premium rows (tier_rank = 0) are not touched.
require("dotenv").config();
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const PLAN = {
  slug: "kovenik-member",
  name: "KOVENIK MEMBER",
  // Rank 1 on purpose. The membership code no longer uses ranks, but a backend that has not been
  // redeployed yet still does: with a rank above Gold it would treat buying this plan as an
  // "upgrade" and end an old Gold/Silver member's paid term early. At rank 1 that old code just
  // blocks the purchase for Silver/Gold holders and renews Bronze ones. Safe with old and new code.
  tier_rank: 1,
  price: 199,
  duration_days: 365,
  discount_percent: 15,
  free_delivery: 0,
  description: "One membership. Flat 15% off on all eligible products, all year.",
  benefits: [
    ["DISCOUNT", 15, "Flat 15% off on all eligible products"],
  ],
};
// Only benefits that actually exist today are seeded. Early access, birthday rewards, priority
// support, exclusive offers and launch notifications have no implementation behind them yet, so
// they are NOT promised on the new plan (admins can add a line later once one is built). Members
// who bought them on an old plan keep seeing them (see getMyMembership).
const LEGACY_SLUGS = ["bronze", "silver", "gold"];

(async () => {
  const apply = process.argv.includes("--apply");
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: /aivencloud\.com$/.test(process.env.DB_HOST || "") ? { rejectUnauthorized: false } : undefined,
  });

  try {
    console.log(`Target: ${process.env.DB_HOST}:${process.env.DB_PORT} / ${process.env.DB_NAME}`);

    const [cols] = await connection.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscription_plans' AND COLUMN_NAME = 'tier_rank'"
    );
    if (cols.length === 0) throw new Error("subscription_plans.tier_rank is missing: apply membership_phase1.sql first.");

    if (apply) {
      // Two runs at once must not interleave (the slug is unique, so the loser would fail anyway).
      const [[lock]] = await connection.query("SELECT GET_LOCK('kovenik_membership_seed', 15) AS got");
      if (Number(lock.got) !== 1) throw new Error("Another seed run holds the lock; try again in a moment.");
      await connection.beginTransaction();
    }

    // 1. The single plan.
    const [existing] = await connection.query("SELECT id FROM subscription_plans WHERE slug = ? LIMIT 1", [PLAN.slug]);
    let planId = existing[0]?.id;
    if (planId) {
      console.log(`plan ${PLAN.slug}: already exists (left untouched)`);
    } else {
      planId = crypto.randomUUID();
      console.log(`plan ${PLAN.slug}: ${apply ? "inserting" : "would insert"} ${PLAN.name} Rs ${PLAN.price} / ${PLAN.duration_days}d, ${PLAN.discount_percent}% off`);
      if (apply) {
        await connection.query(
          `INSERT INTO subscription_plans
             (id, name, slug, description, price, duration_days, tier_rank, free_delivery, discount_percent, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [planId, PLAN.name, PLAN.slug, PLAN.description, PLAN.price, PLAN.duration_days, PLAN.tier_rank, PLAN.free_delivery, PLAN.discount_percent]
        );
      }
    }
    for (const [type, value, description] of PLAN.benefits) {
      const [has] = await connection.query(
        "SELECT id FROM subscription_plan_benefits WHERE plan_id = ? AND benefit_type = ? LIMIT 1",
        [planId, type]
      );
      if (has.length > 0) continue;
      console.log(`  benefit ${type}: ${apply ? "inserting" : "would insert"}`);
      if (apply) {
        await connection.query(
          "INSERT INTO subscription_plan_benefits (id, plan_id, benefit_type, benefit_value, description, active) VALUES (?, ?, ?, ?, ?, 1)",
          [crypto.randomUUID(), planId, type, value, description]
        );
      }
    }

    // 2. Retire the old tiers (hide only) and report who is still on them.
    const [legacy] = await connection.query(
      `SELECT p.id, p.slug, p.active,
              (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id AND s.status = 'active' AND s.end_date > UTC_TIMESTAMP()) AS running_terms,
              (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id) AS all_rows
       FROM subscription_plans p WHERE p.slug IN (?) AND p.tier_rank > 0`,
      [LEGACY_SLUGS]
    );
    for (const plan of legacy) {
      console.log(
        `legacy ${plan.slug}: ${plan.active ? (apply ? "retiring (active = 0)" : "would retire (active = 0)") : "already retired"}` +
          ` | running terms kept: ${plan.running_terms} | subscription rows kept: ${plan.all_rows}`
      );
      if (apply && plan.active) await connection.query("UPDATE subscription_plans SET active = 0 WHERE id = ?", [plan.id]);
    }

    if (apply) {
      await connection.commit();
      console.log("Applied.");
    } else {
      console.log("Dry run only. Re-run with --apply to apply.");
    }
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {}
    throw error;
  } finally {
    await connection.end();
  }
})().catch((error) => {
  console.error("Seed failed:", error.message);
  process.exit(1);
});
