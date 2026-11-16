// Applies scripts/sql/newsletter_phase1.sql (additive, re-runnable, creates 2 new tables).
//
//   node scripts/apply-newsletter-migration.js          -> shows target + what is missing, changes nothing
//   node scripts/apply-newsletter-migration.js --apply  -> runs the migration
//
// The default is a dry run on purpose: the .env database may be the live one.
// BACK UP FIRST (see docs/NEWSLETTER_PHASE1_REPORT.md): the migration only creates tables,
// but a dump costs nothing.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const TABLES = ["newsletter_subscribers", "newsletter_tokens"];

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

    const existing = async () => {
      const [rows] = await connection.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
        [TABLES]
      );
      return rows.map((r) => r.TABLE_NAME);
    };

    const before = await existing();
    const missing = TABLES.filter((t) => !before.includes(t));
    console.log("Existing newsletter tables:", before.length ? before.join(", ") : "(none)");
    console.log("Tables to create          :", missing.length ? missing.join(", ") : "(none, already applied)");

    if (!apply) {
      console.log("Dry run only. Nothing was changed. Re-run with --apply to migrate.");
      return;
    }

    const sql = fs.readFileSync(path.join(__dirname, "sql", "newsletter_phase1.sql"), "utf8");
    await connection.query(sql);
    console.log("Newsletter tables now:", (await existing()).join(", "));
  } finally {
    await connection.end();
  }
})().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exit(1);
});
