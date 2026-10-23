const express = require("express");

const {
  getDashboard,
  listUsers,
  updateUserStatus,
  updateUserRole,
} = require("../controller/superadmin.controller");

const { authenticateToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { rateLimit, perUser } = require("../middleware/security.middleware");

const superAdminRouter = express.Router();

// Every route below needs a valid session AND the superadmin role, checked
// against the database on each request (see authenticateToken).
superAdminRouter.use(authenticateToken, authorizeRoles("superadmin"));

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: perUser,
  message: "Too many requests. Please wait a moment and try again.",
});

superAdminRouter.get("/dashboard", getDashboard);
superAdminRouter.get("/users", listUsers);
superAdminRouter.patch("/users/:userId/status", writeLimiter, updateUserStatus);
superAdminRouter.patch("/users/:userId/role", writeLimiter, updateUserRole);

module.exports = superAdminRouter;
