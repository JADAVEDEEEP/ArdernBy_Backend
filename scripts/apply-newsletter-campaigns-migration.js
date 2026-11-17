// Applies scripts/sql/newsletter_phase3_campaigns.sql (additive, re-runnable, creates 4 new tables).
//
//   node scripts/apply-newsletter-campaigns-migration.js          -> shows target + what is missing, changes nothing
//   node scripts/apply-newsletter-campaigns-migration.js --apply  -> runs the migration
//
// The default is a dry run on purpose: the .env database may be the live one.
// BACK UP FIRST (mysqldump into db-backups/): the migration only creates tables, but a dump costs nothing.
// It refuses to run unless newsletter_subscribers (newsletter_phase1.sql) already exists.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const REQUIRED = ["newsletter_subscribers"];
const TABLES = ["newsletter_templates", "newsletter_campaigns", "newsletter_campaign_recipients", "newsletter_events"];

(async () => {
  const apply = process.argv.includes("--apply");
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: /aivencloud\.com$/.test(process.env.DB_HOST || "") ? { rejectUnauthorized: false } : undefined,
    multipleStatements: true,
  });

  try {
    console.log(`Target: ${process.env.DB_HOST}:${process.env.DB_PORT} / ${process.env.DB_NAME}`);

    const existing = async (names) => {
      const [rows] = await connection.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
        [names]
      );
      return rows.map((r) => r.TABLE_NAME);
    };

    const have = await existing(REQUIRED);
    const missingRequired = REQUIRED.filter((t) => !have.includes(t));
    if (missingRequired.length) {
      throw new Error(`Required table(s) missing: ${missingRequired.join(", ")}. Apply newsletter_phase1.sql first.`);
    }

    const before = await existing(TABLES);
    const missing = TABLES.filter((t) => !before.includes(t));
    console.log("Existing campaign tables:", before.length ? before.join(", ") : "(none)");
    console.log("Tables to create        :", missing.length ? missing.join(", ") : "(none, already applied)");

    if (!apply) {
      console.log("Dry run only. Nothing was changed. Re-run with --apply to migrate.");
      return;
    }

    const sql = fs.readFileSync(path.join(__dirname, "sql", "newsletter_phase3_campaigns.sql"), "utf8");
    await connection.query(sql);
    console.log("Campaign tables now:", (await existing(TABLES)).join(", "));
  } finally {
    await connection.end();
  }
})().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exit(1);
});
