const express = require("express");

const {
  getCart,
  createCart,
  addCartItem,
  updateCartItem,
  removeCartItem,
  clearCart,
  updateCartCoupon,
} = require("../controller/cart.controller");

const { authenticateToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");

const cartRouter = express.Router();

// GET CART
cartRouter.get(
  "/",
  authenticateToken,
  authorizeRoles("customer"),
  getCart
);

// CREATE CART
cartRouter.post(
  "/",
  authenticateToken,
  authorizeRoles("customer"),
  createCart
);

// ADD ITEM
cartRouter.post(
  "/items",
  authenticateToken,
  authorizeRoles("customer"),
  addCartItem
);

// UPDATE ITEM
cartRouter.put(
  "/items/:itemId",
  authenticateToken,
  authorizeRoles("customer"),
  updateCartItem
);

// REMOVE ITEM
cartRouter.delete(
  "/items/:itemId",
  authenticateToken,
  authorizeRoles("customer"),
  removeCartItem
);

// CLEAR CART
cartRouter.delete(
  "/",
  authenticateToken,
  authorizeRoles("customer"),
  clearCart
);

// APPLY / REMOVE COUPON
cartRouter.patch(
  "/coupon",
  authenticateToken,
  authorizeRoles("customer"),
  updateCartCoupon
);

module.exports = cartRouter;