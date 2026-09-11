const express = require("express");

const {
  authenticate,
  verifyOTP,
  forgotPassword,
  resetPassword,
  resendOTP,
  googleLogin,
} = require("../controller/auth.controller");

const authRouter = express.Router();

// ==========================================
// LOGIN OR REGISTER
// ==========================================

authRouter.post(
  "/",
  authenticate
);

// ==========================================
// VERIFY OTP
// ==========================================

authRouter.post(
  "/verify-otp",
  verifyOTP
);

// ==========================================
// FORGOT PASSWORD
// Send password reset OTP
// ==========================================

authRouter.post(
  "/forgot-password",
  forgotPassword
);

// ==========================================
// RESET PASSWORD
// Requires resetToken obtained
// after successful password_reset OTP
// ==========================================

authRouter.post(
  "/reset-password",
  resetPassword
);

// ==========================================
// RESEND OTP
// ==========================================

authRouter.post(
  "/resend-otp",
  resendOTP
);

// ==========================================
// GOOGLE LOGIN
// ==========================================

authRouter.post(
  "/google",
  googleLogin
);

module.exports = authRouter;