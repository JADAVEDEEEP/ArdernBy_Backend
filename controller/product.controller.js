const productService = require("../services/product.service");
const { publicMessage } = require("../utils/public-error");

// ==========================================
// GET ALL PRODUCTS
// ==========================================

const getProducts = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      category,
    } = req.query;

    // Bounded paging: an unbounded `limit` would let anyone dump / stall the catalogue.
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const safePage = Math.min(Math.max(parseInt(page, 10) || 1, 1), 10000);

    const result = await productService.getAllProducts({
      page: safePage,
      limit: safeLimit,
      search: typeof search === "string" ? search.slice(0, 100) : undefined,
      category: typeof category === "string" ? category.slice(0, 100) : undefined,
    });

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("Get products error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch products.",
    });
  }
};

// ==========================================
// GET SINGLE PRODUCT
// ==========================================

const getProduct = async (req, res) => {
  try {
    
    const { slug } = req.params;
    

    const product = await productService.getProductBySlug(slug);

    return res.status(200).json({
      success: true,
      product,
    });
  } catch (error) {
    console.error("Get product error:", error.message);

    return res.status(404).json({
      success: false,
      message: publicMessage(error),
    });
  }
};

// ==========================================
// CREATE PRODUCT
// ==========================================

const createProduct = async (req, res) => {
  try {
    const product = await productService.createProduct(
      req.body,
      req.files || []
    );

    return res.status(201).json({
      success: true,
      message: "Product created successfully.",
      product,
    });
  } catch (error) {
    console.error("Create product error:", error.message);

    return res.status(400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};

// ==========================================
// UPDATE PRODUCT
// ==========================================

const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await productService.updateProduct(
      id,
      req.body,
      req.files || []
    );

    return res.status(200).json({
      success: true,
      message: "Product updated successfully.",
      product,
    });
  } catch (error) {
    console.error("Update product error:", error.message);

    return res.status(400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};

// ==========================================
// DELETE PRODUCT
// ==========================================

const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;

    await productService.deleteProduct(id);

    return res.status(200).json({
      success: true,
      message: "Product deleted successfully.",
    });
  } catch (error) {
    console.error("Delete product error:", error.message);

    return res.status(400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};

module.exports = {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
};