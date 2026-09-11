const authService = require("../services/auth.service");

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
      message: error.message,
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
      message: error.message,
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
      message: error.message,
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
      message: error.message,
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
      message: error.message,
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
      message: error.message,
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