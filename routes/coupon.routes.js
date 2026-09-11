const express = require("express");

const {
  createCoupon,
  getCoupons,
  getCouponByCode,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
} = require("../controller/coupon.controller");

const { authenticateToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");

const couponRouter = express.Router();


// Admin + Superadmin
couponRouter.post(
  "/",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  createCoupon
);


couponRouter.get(
  "/",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  getCoupons
);


couponRouter.get(
  "/:code",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  getCouponByCode
);


couponRouter.put(
  "/:id",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  updateCoupon
);


couponRouter.delete(
  "/:id",
  authenticateToken,
  authorizeRoles("admin", "superadmin"),
  deleteCoupon
);


// Customer + Admin + Superadmin can validate
couponRouter.post(
  "/validate",
  authenticateToken,
  authorizeRoles("customer", "admin", "superadmin"),
  validateCoupon
);


module.exports = couponRouter;