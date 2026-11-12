const mysql = require("mysql2/promise");
const { buildSslOption } = require("./db-ssl");

const ssl = buildSslOption();

const pool = mysql.createPool({
  ...(ssl ? { ssl } : {}),
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "ardenby",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

const poolPromise = (async () => {
  try {
    const connection = await pool.getConnection();

    console.log("✅ MySQL connected");
    console.log("📦 Database:", process.env.DB_NAME || "ardenby");

    // Safe TLS check: logs only the cipher name, never credentials. Never blocks startup.
    try {
      const [rows] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
      const cipher = rows[0] && rows[0].Value;
      console.log(cipher ? `🔒 DB TLS: on (${cipher})` : "⚠️ DB TLS: off (set DB_SSL=required or verify)");
    } catch (_) {
      console.log("ℹ️ DB TLS status could not be read");
    }

    connection.release();
    return pool;
  } catch (error) {
    console.error("❌ MySQL connection failed:", error.message);
    throw error;
  }
})();

const testDatabaseConnection = async () => {
  try {
    const db = await poolPromise;

    const [rows] = await db.query(
      "SELECT DATABASE() AS DatabaseName"
    );

    console.log("📦 Connected Database:", rows[0].DatabaseName);
  } catch (error) {
    console.error("❌ Database connection test failed:", error.message);
  }
};

module.exports = {
  poolPromise,
  testDatabaseConnection,
};