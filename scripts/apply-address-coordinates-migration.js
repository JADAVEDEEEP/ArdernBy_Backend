// Applies (or rolls back) the address coordinates migration. Additive, re-runnable.
//
//   node scripts/apply-address-coordinates-migration.js                          -> dry run, changes nothing
//   node scripts/apply-address-coordinates-migration.js --apply                  -> adds latitude, longitude
//   node scripts/apply-address-coordinates-migration.js --rollback               -> dry run of the undo
//   node scripts/apply-address-coordinates-migration.js --rollback --apply       -> drops the two columns
//   ... --rollback --apply --confirm-data-loss  -> required only if saved coordinates exist
//
// The default is a dry run on purpose: the .env database may be the live one. Set DB_* in the environment
// to point it at a throwaway database instead.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

// 1060 duplicate column; 1091 cannot drop (column already gone).
const ALREADY = new Set([1060, 1091]);

(async () => {
  const apply = process.argv.includes("--apply");
  const rollback = process.argv.includes("--rollback");
  const confirmLoss = process.argv.includes("--confirm-data-loss");

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
    console.log(`Mode  : ${rollback ? "ROLLBACK" : "migrate"} (${apply ? "APPLY" : "dry run"})`);

    // Read-only pre-flight report.
    const [[{ total }]] = await connection.query("SELECT COUNT(*) AS total FROM addresses");
    const [cols] = await connection.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'addresses' AND COLUMN_NAME IN ('latitude','longitude')"
    );
    const have = cols.map((c) => c.COLUMN_NAME || c.column_name);
    console.log(`addresses rows: ${total}; coordinate columns present: ${have.length ? have.join(", ") : "none"}`);

    if (rollback && apply && have.length === 2) {
      const [[{ withCoords }]] = await connection.query(
        "SELECT COUNT(*) AS withCoords FROM addresses WHERE latitude IS NOT NULL OR longitude IS NOT NULL"
      );
      if (withCoords > 0 && !confirmLoss) {
        throw new Error(
          `${withCoords} address(es) have saved coordinates that rollback would delete. Re-run with --confirm-data-loss if that is intended.`
        );
      }
    }

    const file = rollback ? "address_coordinates_phase1_down.sql" : "address_coordinates_phase1.sql";
    const sql = fs.readFileSync(path.join(__dirname, "sql", file), "utf8");
    const statements = sql
      .split(/^-- ;;\s*$/m)
      .map((s) => s.replace(/^--.*$/gm, "").trim())
      .filter(Boolean);

    for (const statement of statements) {
      const label = statement.replace(/\s+/g, " ").slice(0, 120);
      if (!apply) {
        console.log("WOULD RUN:", label);
        continue;
      }
      try {
        await connection.query(statement);
        console.log("applied :", label);
      } catch (error) {
        if (ALREADY.has(error.errno)) console.log("skipped :", label, `(${rollback ? "already removed" : "already exists"})`);
        else throw error;
      }
    }

    const [[{ after }]] = await connection.query("SELECT COUNT(*) AS after FROM addresses");
    console.log(`addresses rows after: ${after} (before: ${total})`);
    if (!apply) console.log("Dry run only. Re-run with --apply to make the change.");
  } finally {
    await connection.end();
  }
})().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exit(1);
});
