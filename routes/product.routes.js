const express = require("express");

const upload = require("../middleware/upload.middleware");
const { verifyImageSignatures } = upload;
const {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} = require("../controller/product.controller");

const {
  getReviews,
  getReviewEligibility,
  createReview,
  updateReview,
  deleteReview,
} = require("../controller/review.controller");
const { rateLimit } = require("../middleware/security.middleware");

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
// CUSTOMER REVIEWS
// ==========================================

productrouter.get("/:slug/reviews", getReviews);

productrouter.get(
  "/:slug/reviews/eligibility",
  authenticateToken,
  getReviewEligibility
);

// Ownership comes from the login token only: /me never takes a user id.
const reviewWriteLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: "Too many review changes. Please try again later.",
  keyFn: (req) => req.user?.id,
});
const reviewPhotos = [upload.array("photos", 3), verifyImageSignatures];

productrouter.post(
  "/:slug/reviews",
  authenticateToken,
  reviewWriteLimit,
  ...reviewPhotos,
  createReview
);

productrouter.put(
  "/:slug/reviews/me",
  authenticateToken,
  reviewWriteLimit,
  ...reviewPhotos,
  updateReview
);

productrouter.delete(
  "/:slug/reviews/me",
  authenticateToken,
  reviewWriteLimit,
  deleteReview
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
  verifyImageSignatures,
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
  verifyImageSignatures,
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
