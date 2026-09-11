const couponService = require("../services/coupon.service");


// CREATE COUPON
const createCoupon = async (req, res) => {
  try {
    const coupon = await couponService.createCoupon(req.body);

    return res.status(201).json({
      success: true,
      message: "Coupon created successfully.",
      coupon,
    });
  } catch (error) {
    console.error("Create coupon error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};


// GET ALL COUPONS
const getCoupons = async (req, res) => {
  try {
    const coupons = await couponService.getCoupons();

    return res.status(200).json({
      success: true,
      coupons,
    });
  } catch (error) {
    console.error("Get coupons error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch coupons.",
    });
  }
};


// GET COUPON BY CODE
const getCouponByCode = async (req, res) => {
  try {
    const coupon = await couponService.getCouponByCode(
      req.params.code
    );

    return res.status(200).json({
      success: true,
      coupon,
    });
  } catch (error) {
    console.error("Get coupon error:", error.message);

    return res.status(404).json({
      success: false,
      message: error.message,
    });
  }
};


// UPDATE COUPON
const updateCoupon = async (req, res) => {
  try {
    const coupon = await couponService.updateCoupon(
      req.params.id,
      req.body
    );

    return res.status(200).json({
      success: true,
      message: "Coupon updated successfully.",
      coupon,
    });
  } catch (error) {
    console.error("Update coupon error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};


// DELETE COUPON
const deleteCoupon = async (req, res) => {
  try {
    await couponService.deleteCoupon(req.params.id);

    return res.status(200).json({
      success: true,
      message: "Coupon deleted successfully.",
    });
  } catch (error) {
    console.error("Delete coupon error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};


// VALIDATE COUPON
const validateCoupon = async (req, res) => {
  try {
    const { code, subtotal } = req.body;

    const result = await couponService.validateCoupon(
      code,
      Number(subtotal)
    );

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("Validate coupon error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};


module.exports = {
  createCoupon,
  getCoupons,
  getCouponByCode,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
};