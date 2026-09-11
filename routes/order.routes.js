const express = require("express");

const {
  createOrder,
  getMyOrders,
  getOrderById,
  cancelOrder,
  getAllOrders,
  updateOrderStatus,
} = require("../controller/order.controller");

const {
  authenticateToken,

} = require("../middleware/auth.middleware");

const { authorizeRoles } = require("../middleware/role.middleware");

const orderRouter = express.Router();


// ==========================================
// CUSTOMER ROUTES
// ==========================================

// Create order
orderRouter.post(
  "/",
  authenticateToken,
  authorizeRoles("customer"),
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
  updateOrderStatus
);


module.exports = orderRouter;