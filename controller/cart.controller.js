const cartService = require("../services/cart.service");

// GET CART
const getCart = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await cartService.getCart(userId);

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("Get cart error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch cart.",
    });
  }
};

// CREATE CART
const createCart = async (req, res) => {
  try {
    const userId = req.user.id;

    const cart = await cartService.createCart(userId);

    return res.status(201).json({
      success: true,
      message: "Cart created successfully.",
      cart,
    });
  } catch (error) {
    console.error("Create cart error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// ADD ITEM TO CART
const addCartItem = async (req, res) => {
  try {
    const userId = req.user.id;

    const cart = await cartService.addCartItem(
      userId,
      req.body
    );

    return res.status(200).json({
      success: true,
      message: "Item added to cart successfully.",
      ...cart,
    });
  } catch (error) {
    console.error("Add cart item error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// UPDATE CART ITEM
const updateCartItem = async (req, res) => {
  try {
    const userId = req.user.id;
    const { itemId } = req.params;
    const { quantity } = req.body;

    const cart = await cartService.updateCartItem(
      userId,
      itemId,
      quantity
    );

    return res.status(200).json({
      success: true,
      message: "Cart item updated successfully.",
      ...cart,
    });
  } catch (error) {
    console.error("Update cart item error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// REMOVE CART ITEM
const removeCartItem = async (req, res) => {
  try {
    const userId = req.user.id;
    const { itemId } = req.params;

    const cart = await cartService.removeCartItem(
      userId,
      itemId
    );

    return res.status(200).json({
      success: true,
      message: "Cart item removed successfully.",
      ...cart,
    });
  } catch (error) {
    console.error("Remove cart item error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// CLEAR CART
const clearCart = async (req, res) => {
  try {
    const userId = req.user.id;

    const cart = await cartService.clearCart(userId);

    return res.status(200).json({
      success: true,
      message: "Cart cleared successfully.",
      ...cart,
    });
  } catch (error) {
    console.error("Clear cart error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// APPLY / REMOVE COUPON
const updateCartCoupon = async (req, res) => {
  try {
    const userId = req.user.id;
    const { coupon_code } = req.body;

    const cart = await cartService.updateCartCoupon(
      userId,
      coupon_code
    );

    return res.status(200).json({
      success: true,
      message: coupon_code
        ? "Coupon applied to cart successfully."
        : "Coupon removed from cart successfully.",
      ...cart,
    });
  } catch (error) {
    console.error("Update cart coupon error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

module.exports = {
  getCart,
  createCart,
  addCartItem,
  updateCartItem,
  removeCartItem,
  clearCart,
  updateCartCoupon,
};