const express = require("express");

const {
  authenticate,
  verifyOTP,
  forgotPassword,
  resetPassword,
  resendOTP,
  googleLogin,
} = require("../controller/auth.controller");

const { rateLimit, perEmail } = require("../middleware/security.middleware");

const authRouter = express.Router();

// Per-account throttles on top of the per-IP ceiling set in app.js.
const WINDOW = 15 * 60 * 1000;
// Anything that sends an OTP email or checks a password.
const sendLimiter = rateLimit({
  windowMs: WINDOW,
  max: 8,
  keyFn: perEmail,
  message: "Too many attempts for this account. Please wait a few minutes and try again.",
});
// Checking a code: 5 wrong guesses already burn the OTP, this bounds re-requests.
const verifyLimiter = rateLimit({
  windowMs: WINDOW,
  max: 15,
  keyFn: perEmail,
  message: "Too many attempts for this account. Please wait a few minutes and try again.",
});

// ==========================================
// LOGIN OR REGISTER
// ==========================================

authRouter.post(
  "/",
  sendLimiter,
  authenticate
);

// ==========================================
// VERIFY OTP
// ==========================================

authRouter.post(
  "/verify-otp",
  verifyLimiter,
  verifyOTP
);

// ==========================================
// FORGOT PASSWORD
// Send password reset OTP
// ==========================================

authRouter.post(
  "/forgot-password",
  sendLimiter,
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
  sendLimiter,
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