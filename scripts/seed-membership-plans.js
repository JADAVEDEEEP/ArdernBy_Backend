// Seeds Bronze / Silver / Gold into the existing subscription tables.
//
//   node scripts/seed-membership-plans.js          -> shows what would be inserted, changes nothing
//   node scripts/seed-membership-plans.js --apply  -> inserts (needs membership_phase1.sql applied first)
//
// Idempotent: a plan is matched by slug and a benefit by (plan, benefit_type); existing
// rows are never updated or deleted, so admin edits and the legacy Free/Plus/Premium
// plans are left alone. Prices etc. are only the INITIAL values; admins edit them afterwards.
require("dotenv").config();
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const PLANS = [
  {
    slug: "bronze", name: "Bronze", tier_rank: 1, price: 99, duration_days: 365, discount_percent: 5, free_delivery: 0,
    description: "Entry membership: member pricing and exclusive offers.",
    benefits: [
      ["DISCOUNT", 5, "5% off eligible products"],
      ["EXCLUSIVE_OFFERS", null, "Exclusive member offers"],
      ["NEW_LAUNCH_NOTIFICATIONS", null, "New collection launch notifications"],
      ["BIRTHDAY_COUPON", null, "Birthday special coupon"],
    ],
  },
  {
    slug: "silver", name: "Silver", tier_rank: 2, price: 199, duration_days: 365, discount_percent: 8, free_delivery: 0,
    description: "More savings, early access and priority support.",
    benefits: [
      ["DISCOUNT", 8, "8% off eligible products"],
      ["EARLY_ACCESS", 24, "24-hour early access to new collections"],
      ["EXCLUSIVE_OFFERS", null, "Exclusive Silver member offers"],
      ["BIRTHDAY_COUPON", null, "Birthday special coupon"],
      ["PRIORITY_SUPPORT", null, "Priority customer support"],
    ],
  },
  {
    slug: "gold", name: "Gold", tier_rank: 3, price: 399, duration_days: 365, discount_percent: 12, free_delivery: 1,
    description: "Our best membership: biggest savings, longest early access, free shipping.",
    benefits: [
      ["DISCOUNT", 12, "12% off eligible products"],
      ["EARLY_ACCESS", 48, "48-hour early access to new collections"],
      ["EXCLUSIVE_OFFERS", null, "Exclusive Gold member offers"],
      ["BIRTHDAY_REWARD", null, "Special birthday reward"],
      ["PRIORITY_SUPPORT", null, "Priority customer support"],
      ["FREE_DELIVERY", null, "Free shipping on eligible orders"],
    ],
  },
];

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

    for (const plan of PLANS) {
      const [existing] = await connection.query("SELECT id FROM subscription_plans WHERE slug = ? LIMIT 1", [plan.slug]);
      let planId = existing[0]?.id;

      if (planId) {
        console.log(`plan ${plan.slug}: already exists (left untouched)`);
      } else {
        planId = crypto.randomUUID();
        console.log(`plan ${plan.slug}: ${apply ? "inserting" : "would insert"} ${plan.name} Rs ${plan.price} / ${plan.duration_days}d`);
        if (apply) {
          await connection.query(
            `INSERT INTO subscription_plans
               (id, name, slug, description, price, duration_days, tier_rank, free_delivery, discount_percent, active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [planId, plan.name, plan.slug, plan.description, plan.price, plan.duration_days, plan.tier_rank, plan.free_delivery, plan.discount_percent]
          );
        }
      }

      for (const [type, value, description] of plan.benefits) {
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
    }

    if (!apply) console.log("Dry run only. Re-run with --apply to seed.");
  } finally {
    await connection.end();
  }
})().catch((error) => {
  console.error("Seed failed:", error.message);
  process.exit(1);
});
