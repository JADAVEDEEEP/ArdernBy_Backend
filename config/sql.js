// const sql = require("mssql/msnodesqlv8");

// const dbConfig = {
//   server: "localhost\\SQLEXPRESS01",
//   database: "Dbo_AdrenBy_Shop",

//   driver: "ODBC Driver 18 for SQL Server",

//   options: {
//     trustedConnection: true,
//     trustServerCertificate: true,
//   },

//   pool: {
//     max: 10,
//     min: 0,
//     idleTimeoutMillis: 30000,
//   },

//   connectionTimeout: 15000,
//   requestTimeout: 30000,
// };

// const poolPromise = new sql.ConnectionPool(dbConfig)
//   .connect()
//   .then((pool) => {
//     console.log("✅ SQL Server connected");
//     console.log("📦 Database: Dbo_AdrenBy_Shop");
//     return pool;
//   })
//   .catch((error) => {
//     console.error(
//       "❌ SQL Server connection failed:",
//       error.message
//     );
//     throw error;
//   });

// const testDatabaseConnection = async () => {
//   try {
//     const pool = await poolPromise;

//     const result = await pool
//       .request()
//       .query("SELECT DB_NAME() AS DatabaseName");

//     console.log(
//       "📦 Database:",
//       result.recordset[0].DatabaseName
//     );
//   } catch (error) {
//     console.error(
//       "❌ Database connection test failed:",
//       error.message
//     );
//   }
// };

// module.exports = {
//   sql,
//   poolPromise,
//   testDatabaseConnection,
// };


const sql = require("mssql");

const dbConfig = {
  server: process.env.DB_SERVER,
  port: Number(process.env.DB_PORT || 1433),
  database: process.env.DB_NAME,

  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,

  options: {
    encrypt: true,
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
    console.log("✅ MonsterASP SQL Server connected");
    console.log("📦 Database:", process.env.DB_NAME);
    return pool;
  })
  .catch((error) => {
    console.error("❌ SQL Server connection failed:", error.message);
    throw error;
  });

const testDatabaseConnection = async () => {
  try {
    const pool = await poolPromise;

    const result = await pool
      .request()
      .query("SELECT DB_NAME() AS DatabaseName");

    console.log(
      "📦 Connected Database:",
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
