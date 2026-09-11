const categoryService = require("../services/category.service");

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
      message: error.message,
    });
  }
};

// CREATE CATEGORY
const createCategory = async (req, res) => {
  try {
    const category = await categoryService.createCategory(req.body);

    return res.status(201).json({
      success: true,
      message: "Category created successfully.",
      category,
    });
  } catch (error) {
    console.error("Create category error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// UPDATE CATEGORY
const updateCategory = async (req, res) => {
  try {
    const { slug } = req.params;

    const category = await categoryService.updateCategory(
      slug,
      req.body
    );

    return res.status(200).json({
      success: true,
      message: "Category updated successfully.",
      category,
    });
  } catch (error) {
    console.error("Update category error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// DELETE CATEGORY
const deleteCategory = async (req, res) => {
  try {
    const { slug } = req.params;

    await categoryService.deleteCategory(slug);

    return res.status(200).json({
      success: true,
      message: "Category deleted successfully.",
    });
  } catch (error) {
    console.error("Delete category error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
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