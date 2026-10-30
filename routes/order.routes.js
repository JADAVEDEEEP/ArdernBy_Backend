const express = require("express");
const refundSync = require("../controller/refund-sync.controller");

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

const cancellation = require("../controller/cancellation.controller");

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

// Cancellation options / refund estimate (the server decides eligibility and amounts)
orderRouter.get(
  "/:orderId/cancel-options",
  authenticateToken,
  authorizeRoles("customer"),
  cancellation.options
);
orderRouter.post(
  "/:orderId/cancel-preview",
  authenticateToken,
  authorizeRoles("customer"),
  orderWriteLimiter,
  cancellation.preview
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

// Cancellation with a reason, full or by item
orderRouter.get(
  "/admin/:orderId/cancel-options",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  cancellation.adminOptions
);
orderRouter.post(
  "/admin/:orderId/cancel-preview",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  orderWriteLimiter,
  cancellation.adminPreview
);
orderRouter.post(
  "/admin/:orderId/cancel",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  orderWriteLimiter,
  cancellation.adminCancel
);

// Update order status
orderRouter.patch(
  "/admin/:orderId/status",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  orderWriteLimiter,
  updateOrderStatus
);


// Refund history of an order, and the read-only "check with Razorpay" (never creates a refund)
orderRouter.get(
  "/admin/:orderId/refunds",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  refundSync.history
);

orderRouter.post(
  "/admin/:orderId/refunds/check",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  orderWriteLimiter,
  refundSync.check
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