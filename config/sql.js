const sql = require("mssql/msnodesqlv8");

const dbConfig = {
  server: "localhost\\SQLEXPRESS01",
  database: "Dbo_AdrenBy_Shop",

  driver: "ODBC Driver 18 for SQL Server",

  options: {
    trustedConnection: true,
    trustServerCertificate: true,
  },

  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },

  connectionTimeout: 15000,
  requestTimeout: 30000,
};

const poolPromise = new sql.ConnectionPool(dbConfig)
  .connect()
  .then((pool) => {
    console.log("✅ SQL Server connected");
    console.log("📦 Database: Dbo_AdrenBy_Shop");
    return pool;
  })
  .catch((error) => {
    console.error(
      "❌ SQL Server connection failed:",
      error.message
    );
    throw error;
  });

const testDatabaseConnection = async () => {
  try {
    const pool = await poolPromise;

    const result = await pool
      .request()
      .query("SELECT DB_NAME() AS DatabaseName");

    console.log(
      "📦 Database:",
      result.recordset[0].DatabaseName
    );
  } catch (error) {
    console.error(
      "❌ Database connection test failed:",
      error.message
    );
  }
};

module.exports = {
  sql,
  poolPromise,
  testDatabaseConnection,
};