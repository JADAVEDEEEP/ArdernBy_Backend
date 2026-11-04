// Applies scripts/sql/editorial_banners_phase1.sql (additive, re-runnable).
//
//   node scripts/apply-banner-migration.js          -> shows target + what is missing, changes nothing
//   node scripts/apply-banner-migration.js --apply  -> runs the migration
//
// The default is a dry run on purpose: the .env database may be the live one.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const WANTED = ["link_url", "mobile_image_url", "start_at", "end_at", "sort_order"];

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

    const columns = async () => {
      const [rows] = await connection.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'editorial_banners'`
      );
      return rows.map((r) => r.COLUMN_NAME);
    };

    const before = await columns();
    if (before.length === 0) throw new Error("editorial_banners does not exist; refusing to create it.");
    const missing = WANTED.filter((c) => !before.includes(c));
    console.log("Existing columns:", before.join(", "));
    console.log("Missing columns :", missing.length ? missing.join(", ") : "(none)");

    if (!apply) {
      console.log("Dry run only. Re-run with --apply to migrate.");
      return;
    }

    const sql = fs.readFileSync(path.join(__dirname, "sql", "editorial_banners_phase1.sql"), "utf8");
    await connection.query(sql);
    console.log("Columns now:", (await columns()).join(", "));
  } finally {
    await connection.end();
  }
})().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exit(1);
});
