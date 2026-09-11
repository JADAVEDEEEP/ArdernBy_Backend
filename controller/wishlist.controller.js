const wishlistService = require("../services/wishlist.service");

// ==========================================
// GET WISHLIST
// ==========================================

const getWishlist = async (req, res) => {
  try {
    const userId = req.user.id;

    const wishlist =
      await wishlistService.getWishlist(userId);

    return res.status(200).json({
      success: true,
      count: wishlist.length,
      wishlist,
    });
  } catch (error) {
    console.error(
      "Get wishlist error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// ADD TO WISHLIST
// ==========================================

const addToWishlist = async (req, res) => {
  try {
    const userId = req.user.id;
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Product ID is required.",
      });
    }

    const wishlistItem =
      await wishlistService.addToWishlist({
        userId,
        productId,
      });

    return res.status(201).json({
      success: true,
      message: "Product added to wishlist.",
      item: wishlistItem,
    });
  } catch (error) {
    console.error(
      "Add wishlist error:",
      error.message
    );

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// REMOVE FROM WISHLIST
// ==========================================

const removeFromWishlist = async (req, res) => {
  try {
    const userId = req.user.id;
    const { productId } = req.params;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Product ID is required.",
      });
    }

    const removed =
      await wishlistService.removeFromWishlist({
        userId,
        productId,
      });

    return res.status(200).json({
      success: true,
      message: "Product removed from wishlist.",
      item: removed,
    });
  } catch (error) {
    console.error(
      "Remove wishlist error:",
      error.message
    );

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// CHECK WISHLIST
// ==========================================

const checkWishlist = async (req, res) => {
  try {
    const userId = req.user.id;
    const { productId } = req.params;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Product ID is required.",
      });
    }

    const exists =
      await wishlistService.isInWishlist({
        userId,
        productId,
      });

    return res.status(200).json({
      success: true,
      productId,
      isInWishlist: exists,
    });
  } catch (error) {
    console.error(
      "Check wishlist error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// CLEAR WISHLIST
// ==========================================

const clearWishlist = async (req, res) => {
  try {
    const userId = req.user.id;

    const result =
      await wishlistService.clearWishlist(userId);

    return res.status(200).json({
      success: true,
      message: "Wishlist cleared successfully.",
      ...result,
    });
  } catch (error) {
    console.error(
      "Clear wishlist error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  getWishlist,
  addToWishlist,
  removeFromWishlist,
  checkWishlist,
  clearWishlist,
};