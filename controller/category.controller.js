const categoryService = require("../services/category.service");
const { publicMessage } = require("../utils/public-error");
const audit = require("../services/audit.service");

// GET ALL CATEGORIES
const getCategories = async (req, res) => {
  try {
    const categories = await categoryService.getAllCategories();

    return res.status(200).json({
      success: true,
      categories,
    });
  } catch (error) {
    console.error("Get categories error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch categories.",
    });
  }
};

// GET SINGLE CATEGORY
const getCategory = async (req, res) => {
  try {
    const { slug } = req.params;

    const category = await categoryService.getCategoryBySlug(slug);

    return res.status(200).json({
      success: true,
      category,
    });
  } catch (error) {
    console.error("Get category error:", error.message);

    return res.status(404).json({
      success: false,
      message: publicMessage(error),
    });
  }
};

// CREATE CATEGORY
const createCategory = async (req, res) => {
  try {
    const category = await categoryService.createCategory(req.body);

    await audit.record({
      req,
      action: "category.create",
      resourceType: "category",
      resourceId: category?.slug,
      after: category,
    });

    return res.status(201).json({
      success: true,
      message: "Category created successfully.",
      category,
    });
  } catch (error) {
    console.error("Create category error:", error.message);

    return res.status(400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};

// UPDATE CATEGORY
const updateCategory = async (req, res) => {
  try {
    const { slug } = req.params;

    const before = await audit.snapshotRow("categories", slug);

    const category = await categoryService.updateCategory(
      slug,
      req.body
    );

    await audit.record({
      req,
      action: "category.update",
      resourceType: "category",
      resourceId: slug,
      before,
      after: category,
    });

    return res.status(200).json({
      success: true,
      message: "Category updated successfully.",
      category,
    });
  } catch (error) {
    console.error("Update category error:", error.message);

    return res.status(400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};

// DELETE CATEGORY
const deleteCategory = async (req, res) => {
  try {
    const { slug } = req.params;

    const before = await audit.snapshotRow("categories", slug);

    await categoryService.deleteCategory(slug);

    await audit.record({
      req,
      action: "category.delete",
      resourceType: "category",
      resourceId: slug,
      before,
    });

    return res.status(200).json({
      success: true,
      message: "Category deleted successfully.",
    });
  } catch (error) {
    console.error("Delete category error:", error.message);

    return res.status(400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};

module.exports = {
  getCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
};