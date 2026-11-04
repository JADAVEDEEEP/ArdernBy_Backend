// Applies scripts/sql/membership_phase1.sql (additive, re-runnable).
//
//   node scripts/apply-membership-migration.js          -> prints what it would do, changes nothing
//   node scripts/apply-membership-migration.js --apply  -> runs it
//
// The default is a dry run on purpose: the .env database may be the live one.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

// 1060 duplicate column, 1061 duplicate key name, 1050 table exists.
const ALREADY = new Set([1060, 1061, 1050]);

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
    const sql = fs.readFileSync(path.join(__dirname, "sql", "membership_phase1.sql"), "utf8");
    const statements = sql
      .split(/^-- ;;\s*$/m)
      .map((s) => s.replace(/^--.*$/gm, "").trim())
      .filter(Boolean);

    for (const statement of statements) {
      const label = statement.replace(/\s+/g, " ").slice(0, 110);
      if (!apply) {
        console.log("WOULD RUN:", label);
        continue;
      }
      try {
        await connection.query(statement);
        console.log("applied :", label);
      } catch (error) {
        if (ALREADY.has(error.errno)) console.log("exists  :", label);
        else throw error;
      }
    }
    if (!apply) console.log("Dry run only. Re-run with --apply to migrate.");
  } finally {
    await connection.end();
  }
})().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exit(1);
});
