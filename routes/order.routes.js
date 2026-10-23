const express = require("express");

const {
  createOrder,
  getMyOrders,
  getOrderById,
  cancelOrder,
  getAllOrders,
  updateOrderStatus,
  retryCancellationRefund,
} = require("../controller/order.controller");

const {
  authenticateToken,

} = require("../middleware/auth.middleware");

const { authorizeRoles } = require("../middleware/role.middleware");
const { rateLimit, perUser } = require("../middleware/security.middleware");

const orderRouter = express.Router();

// Repeated order / cancel requests (double clicks, scripts) are throttled per
// account. The services are also idempotent; this is an extra ceiling.
const orderWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyFn: perUser,
  message: "Too many requests. Please wait a moment and try again.",
});


// ==========================================
// CUSTOMER ROUTES
// ==========================================

// Create order
orderRouter.post(
  "/",
  authenticateToken,
  authorizeRoles("customer"),
  orderWriteLimiter,
  createOrder
);

// My orders
orderRouter.get(
  "/my",
  authenticateToken,
  authorizeRoles("customer"),
  getMyOrders
);

// Single order
orderRouter.get(
  "/:orderId",
  authenticateToken,
  authorizeRoles("customer"),
  getOrderById
);

// Cancel order
orderRouter.patch(
  "/:orderId/cancel",
  authenticateToken,
  authorizeRoles("customer"),
  orderWriteLimiter,
  cancelOrder
);


// ==========================================
// ADMIN ROUTES
// ==========================================

// Get all orders
orderRouter.get(
  "/admin/all",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  getAllOrders
);

// Update order status
orderRouter.patch(
  "/admin/:orderId/status",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  orderWriteLimiter,
  updateOrderStatus
);


// Complete a pending cancellation by retrying its refund
orderRouter.patch(
  "/admin/:orderId/retry-refund",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  orderWriteLimiter,
  retryCancellationRefund
);


module.exports = orderRouter;