const express = require("express");

const upload = require("../middleware/upload.middleware");

const {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} = require("../controller/product.controller");

const {
  authorizeRoles,
} = require("../middleware/role.middleware");

const {
  authenticateToken,
} = require("../middleware/auth.middleware");

const productrouter = express.Router();

// ==========================================
// TEST ROLE AUTHORIZATION
// ==========================================

productrouter.get(
  "/test-role",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  (req, res) => {
    res.json({
      success: true,
      message: "Role authorization working.",
      user: req.user,
    });
  }
);

// ==========================================
// GET ALL PRODUCTS
// ==========================================

productrouter.get(
  "/",
  getProducts
);

// ==========================================
// GET SINGLE PRODUCT
// ==========================================

productrouter.get(
  "/:slug",
  getProduct
);

// ==========================================
// CREATE PRODUCT
// ADMIN + SUPERADMIN
// ==========================================

productrouter.post(
  "/",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  upload.array("images", 6),
  createProduct
);

// ==========================================
// UPDATE PRODUCT
// ADMIN + SUPERADMIN
// ==========================================

productrouter.put(
  "/:id",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  upload.array("images", 6),
  updateProduct
);

// ==========================================
// DELETE PRODUCT
// ADMIN + SUPERADMIN
// ==========================================

productrouter.delete(
  "/:id",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  deleteProduct
);

module.exports = productrouter;