const express = require("express");

const {
  getCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
} = require("../controller/category.controller");

const { authenticateToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");

const categoryRouter = express.Router();

// GET ALL CATEGORIES
categoryRouter.get("/", getCategories);

// GET SINGLE CATEGORY
categoryRouter.get("/:slug", getCategory);

// CREATE CATEGORY
categoryRouter.post(
  "/",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  createCategory
);

// UPDATE CATEGORY
categoryRouter.put(
  "/:slug",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  updateCategory
);

// DELETE CATEGORY
categoryRouter.delete(
  "/:slug",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  deleteCategory
);

module.exports = categoryRouter;