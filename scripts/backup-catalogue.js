// Writes a restorable SQL backup of the catalogue tables (categories, products, product_images,
// product_variants) to ../db-backups. Read-only. Used automatically by seed-catalogue.js --apply.
//   node scripts/backup-catalogue.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const TABLES = ["categories", "products", "product_images", "product_variants"];

async function connect() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: /aivencloud\.com$/.test(process.env.DB_HOST || "") ? { rejectUnauthorized: false } : undefined,
    dateStrings: true,
  });
}

async function backupCatalogue(conn) {
  const own = !conn;
  conn = conn || (await connect());
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(__dirname, "..", "..", "db-backups", `ardenby-catalogue-pre-seed-${stamp}.sql`);
    let sql = `-- KOVENIK catalogue backup ${stamp}. Restore: delete the rows you want back, then run this file.\n`;
    for (const t of TABLES) {
      const [rows] = await conn.query(`SELECT * FROM \`${t}\``);
      sql += `\n-- ${t}: ${rows.length} rows\n`;
      for (const r of rows) {
        const cols = Object.keys(r).map((c) => `\`${c}\``).join(", ");
        const vals = Object.values(r).map((v) => conn.escape(v)).join(", ");
        sql += `INSERT IGNORE INTO \`${t}\` (${cols}) VALUES (${vals});\n`;
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, sql, "utf8");
    return file;
  } finally {
    if (own) await conn.end();
  }
}

module.exports = { backupCatalogue, connect };

if (require.main === module) {
  backupCatalogue()
    .then((f) => console.log("Backup written:", f))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
