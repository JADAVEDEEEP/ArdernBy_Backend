const jwt = require("jsonwebtoken");
const { getJwtSecret } = require("../config/jwt");
const { poolPromise } = require("../config/sql");

const unauthorized = (res, message) =>
  res.status(401).json({ success: false, message });

// Verifies the Bearer token and then re-reads the account from the database.
//
// The signed token only proves who the caller is. The role and the active flag
// are always taken from the database, so a demoted, deactivated or deleted
// account loses access immediately instead of keeping a stale role until the
// token expires.
const authenticateToken = async (req, res, next) => {
  let decoded;

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return unauthorized(res, "Authorization token is required.");
    }

    const parts = authHeader.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
      return unauthorized(res, "Invalid authorization format.");
    }

    // Pin the algorithm so a token can never pick a weaker one.
    decoded = jwt.verify(parts[1], getJwtSecret(), {
      algorithms: ["HS256"],
    });
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return unauthorized(res, "Token has expired.");
    }

    return unauthorized(res, "Invalid token.");
  }

  // Password-reset (and any other single-purpose) tokens are not sessions.
  if (!decoded || typeof decoded.id !== "string" || decoded.purpose) {
    return unauthorized(res, "Invalid token.");
  }

  try {
    const pool = await poolPromise;
    const [rows] = await pool.execute(
      "SELECT id, email, role, is_active FROM profiles WHERE id = ? LIMIT 1",
      [decoded.id]
    );
    const account = rows[0];

    if (!account || !account.is_active) {
      return unauthorized(res, "Invalid token.");
    }

    req.user = {
      id: account.id,
      email: account.email,
      role: account.role,
    };

    return next();
  } catch (error) {
    console.error("Auth lookup failed:", error.message);
    return res.status(503).json({
      success: false,
      message: "Unable to verify your session right now. Please try again.",
    });
  }
};

module.exports = {
  authenticateToken,
};
