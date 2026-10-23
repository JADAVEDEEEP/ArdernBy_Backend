const express = require("express");

const {
  createRazorpayOrder,
  verifyRazorpayPayment,
  reportPaymentFailure,
  syncRazorpayPayment,
} = require("../controller/payment.controller");

const { authenticateToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");

const { rateLimit, perUser } = require("../middleware/security.middleware");

const paymentRouter = express.Router();

paymentRouter.use(
  authenticateToken,
  authorizeRoles("customer"),
  rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyFn: perUser,
    message: "Too many payment requests. Please wait a moment and try again.",
  })
);

paymentRouter.post("/razorpay/order", createRazorpayOrder);
paymentRouter.post("/razorpay/verify", verifyRazorpayPayment);
paymentRouter.post("/razorpay/failed", reportPaymentFailure);
paymentRouter.post("/razorpay/sync", syncRazorpayPayment);

module.exports = paymentRouter;
