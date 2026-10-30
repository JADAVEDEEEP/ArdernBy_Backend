const express = require("express");

const {
  getDashboard,
  listUsers,
  updateUserStatus,
  requestRoleChange,
  updateUserRole,
  requestAdminInvite,
  createAdmin,
  listAuditLogs,
  getFinancialReport,
} = require("../controller/superadmin.controller");
const { exportOrders, exportSalesSummary } = require("../controller/admin-ops.controller");

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
// Role changes are two steps: ask for an e-mailed code, then confirm with it.
superAdminRouter.post("/users/:userId/role/request", writeLimiter, requestRoleChange);
superAdminRouter.patch("/users/:userId/role", writeLimiter, updateUserRole);

// Admin accounts are created by invitation, with the same fresh confirmation.
superAdminRouter.post("/admins/request", writeLimiter, requestAdminInvite);
superAdminRouter.post("/admins", writeLimiter, createAdmin);

// Read-only: the audit trail and the detailed financial report.
superAdminRouter.get("/audit-logs", listAuditLogs);
superAdminRouter.get("/reports/financial", getFinancialReport);

// Exports. Customer details and the sales summary are Super Admin only.
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  keyFn: perUser,
  message: "Too many exports. Please wait a moment and try again.",
});
superAdminRouter.get("/exports/orders.csv", exportLimiter, exportOrders);
superAdminRouter.get("/exports/sales-summary.csv", exportLimiter, exportSalesSummary);

module.exports = superAdminRouter;
