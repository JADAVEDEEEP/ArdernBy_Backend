const express = require("express");

const {
  getAddresses,
  getAddressById,
  createAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
} = require("../controller/address.controller");
const { authorizeRoles } = require("../middleware/role.middleware");
const {
  authenticateToken,
} = require("../middleware/auth.middleware");

const addressRouter = express.Router();

// ==========================================
// CUSTOMER ADDRESS ROUTES
// ==========================================

// Get all addresses
addressRouter.get(
  "/",
  authenticateToken,
  authorizeRoles("customer"),
  getAddresses
);

// Get single address
addressRouter.get(
  "/:addressId",
  authenticateToken,
  authorizeRoles("customer"),
  getAddressById
);

// Add new address
addressRouter.post(
  "/",
  authenticateToken,
  authorizeRoles("customer"),
  createAddress
);

// Update address
addressRouter.put(
  "/:addressId",
  authenticateToken,
  authorizeRoles("customer"),
  updateAddress
);

// Set default address
addressRouter.patch(
  "/:addressId/default",
  authenticateToken,
  authorizeRoles("customer"),
  setDefaultAddress
);

// Delete address
addressRouter.delete(
  "/:addressId",
  authenticateToken,
  authorizeRoles("customer"),
  deleteAddress
);

module.exports = addressRouter;