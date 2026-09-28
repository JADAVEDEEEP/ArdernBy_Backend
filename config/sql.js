const mysql = require("mysql2/promise");

const pool = mysql.createPool({
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