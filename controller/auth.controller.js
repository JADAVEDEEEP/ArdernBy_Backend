const authService = require("../services/auth.service");
const { publicMessage } = require("../utils/public-error");

// Body fields must be plain strings: objects/arrays (e.g. {"$ne": ""}) are
// rejected before they reach the service layer.
const isString = (value, max = 254) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isEmail = (value) => isString(value) && EMAIL_PATTERN.test(value.trim());
const invalid = (res, message = "Invalid request.") =>
  res.status(400).json({ success: false, message });

// ==========================================
// AUTH — LOGIN OR REGISTER
// ==========================================

const authenticate = async (req, res) => {
  try {
    const {
      fullName,
      phone,
      email,
      password,
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
    }

    if (
      !isEmail(email) ||
      !isString(password, 128) ||
      (fullName != null && !isString(fullName, 120)) ||
      (phone != null && !isString(phone, 20))
    ) {
      return invalid(res, "Please check your details and try again.");
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message:
          "Password must be at least 8 characters.",
      });
    }

    const result =
      await authService.authenticate({
        fullName,
        phone,
        email: email.trim().toLowerCase(),
        password,
      });

    return res.status(
      result.isNewUser ? 201 : 200
    ).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error(
      "Auth error:",
      error.message
    );

    return res.status(400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};

// ==========================================
// VERIFY OTP
// ==========================================

const verifyOTP = async (req, res) => {
  try {
    const {
      email,
      otp,
      purpose,
    } = req.body;

    if (!email || !otp || !purpose) {
      return res.status(400).json({
        success: false,
        message:
          "Email, OTP and purpose are required.",
      });
    }

    if (!isEmail(email) || typeof otp !== "string" || typeof purpose !== "string") {
      return invalid(res);
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        message: "OTP must be 6 digits.",
      });
    }

    if (
      ![
        "login",
        "email_verification",
        "password_reset",
      ].includes(purpose)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP purpose.",
      });
    }

    const result =
      await authService.verifyUserOTP({
        email: email.trim().toLowerCase(),
        otp,
        purpose,
      });

    return res.status(200).json({
      success: true,

      message:
        purpose === "password_reset"
          ? "OTP verified successfully."
          : "Login successful.",

      ...result,
    });
  } catch (error) {
    console.error(
      "OTP verification error:",
      error.message
    );

    return res.status(400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};

// ==========================================
// FORGOT PASSWORD — REQUEST OTP
// ==========================================

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required.",
      });
    }

    if (!isEmail(email)) {
      return invalid(res, "Enter a valid email address.");
    }

    const result =
      await authService.requestPasswordReset(
        email.trim().toLowerCase()
      );

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error(
      "Forgot password error:",
      error.message
    );

    return res.status(400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};

// ==========================================
// RESET PASSWORD
// OTP VERIFIED → RESET TOKEN REQUIRED
// ==========================================

const resetPassword = async (req, res) => {
  try {
    const {
      resetToken,
      newPassword,
    } = req.body;

    if (!resetToken || !newPassword) {
      return res.status(400).json({
        success: false,
        message:
          "Reset token and new password are required.",
      });
    }

    if (!isString(resetToken, 2000) || !isString(newPassword, 128)) {
      return invalid(res);
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message:
          "New password must be at least 8 characters.",
      });
    }

    await authService.resetPassword({
      resetToken,
      newPassword,
    });

    return res.status(200).json({
      success: true,
      message:
        "Password reset successfully.",
    });
  } catch (error) {
    console.error(
      "Reset password error:",
      error.message
    );

    return res.status(400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};

// ==========================================
// RESEND OTP
// ==========================================

const resendOTP = async (req, res) => {
  try {
    const {
      email,
      userId,
      purpose,
    } = req.body;

    if (!email || !purpose) {
      return res.status(400).json({
        success: false,
        message:
          "Email and OTP purpose are required.",
      });
    }

    if (
      !isEmail(email) ||
      typeof purpose !== "string" ||
      (userId != null && typeof userId !== "string")
    ) {
      return invalid(res);
    }

    if (
      ![
        "login",
        "email_verification",
        "password_reset",
      ].includes(purpose)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP purpose.",
      });
    }

    const result =
      await authService.resendOTP({
        email: email.trim().toLowerCase(),
        userId,
        purpose,
      });

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error(
      "Resend OTP error:",
      error.message
    );

    return res.status(400).json({
      success: false,
      message: publicMessage(error),
    });
  }
};

// ==========================================
// GOOGLE LOGIN
// ==========================================

const googleLogin = async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({
        success: false,
        message:
          "Google credential is required.",
      });
    }

    if (!isString(credential, 4000)) {
      return invalid(res);
    }

    const result =
      await authService.googleLogin(
        credential
      );

    return res.status(200).json({
      success: true,
      message:
        "Google login successful.",
      ...result,
    });
  } catch (error) {
    console.error(
      "Google login error:",
      error.message
    );

    return res.status(401).json({
      success: false,
      message: publicMessage(error),
    });
  }
};

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  authenticate,
  verifyOTP,
  forgotPassword,
  resetPassword,
  resendOTP,
  googleLogin,
};