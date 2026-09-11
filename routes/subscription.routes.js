const express = require("express");

const {
  getPlans,
  getPlanById,
  getMySubscription,
  createSubscription,
  activateSubscription,
  cancelSubscription,
  checkActiveSubscription,
} = require("../controller/subscription.controller");

const {
  authenticateToken,
} = require("../middleware/auth.middleware");

const { authorizeRoles } = require("../middleware/role.middleware");

const subscriptionRouter = express.Router();

// ==========================================
// PUBLIC ROUTES
// ==========================================

// Get all active subscription plans
subscriptionRouter.get(
  "/plans",
  getPlans
);

// Get single subscription plan
subscriptionRouter.get(
  "/plans/:planId",
  getPlanById
);

// ==========================================
// CUSTOMER ROUTES
// ==========================================

// Get logged-in user's subscription
subscriptionRouter.get(
  "/my",
  authenticateToken,
  authorizeRoles("customer"),
  getMySubscription
);

// Create pending subscription
subscriptionRouter.post(
  "/",
  authenticateToken,
  authorizeRoles("customer"),
  createSubscription
);

// Check active subscription
subscriptionRouter.get(
  "/active",
  authenticateToken,
  authorizeRoles("customer"),
  checkActiveSubscription
);

// Cancel subscription
subscriptionRouter.patch(
  "/:subscriptionId/cancel",
  authenticateToken,
  authorizeRoles("customer"),
  cancelSubscription
);

// ==========================================
// PAYMENT / ACTIVATION
// ==========================================

// Activate subscription after successful payment
subscriptionRouter.patch(
  "/:subscriptionId/activate",
  authenticateToken,
  authorizeRoles("customer"),
  activateSubscription
);

module.exports = subscriptionRouter;