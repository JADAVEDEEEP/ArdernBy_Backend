const express = require("express");

const {
  getWishlist,
  addToWishlist,
  removeFromWishlist,
  checkWishlist,
  clearWishlist,
} = require("../controller/wishlist.controller");

const {
  authenticateToken,
} = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");

const wishlistRouter = express.Router();

// ==========================================
// CUSTOMER WISHLIST
// ==========================================

// Get wishlist
wishlistRouter.get(
  "/",
  authenticateToken,
  authorizeRoles("customer"),
  getWishlist
);

// Add product
wishlistRouter.post(
  "/",
  authenticateToken,
  authorizeRoles("customer"),
  addToWishlist
);

// Check product
wishlistRouter.get(
  "/check/:productId",
  authenticateToken,
  authorizeRoles("customer"),
  checkWishlist
);

// Remove product
wishlistRouter.delete(
  "/:productId",
  authenticateToken,
  authorizeRoles("customer"),
  removeFromWishlist
);

// Clear wishlist
wishlistRouter.delete(
  "/",
  authenticateToken,
  authorizeRoles("customer"),
  clearWishlist
);

module.exports = wishlistRouter;