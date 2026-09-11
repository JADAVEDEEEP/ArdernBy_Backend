const userService = require("../services/user.service");

// ==========================================
// GET CURRENT USER
// ==========================================

const getMe = async (req, res) => {
  try {
    const user = await userService.getUserById(req.user.id);

    return res.status(200).json({
      success: true,
      user,
    });
  } catch (error) {
    console.error("Get user error:", error.message);

    return res.status(404).json({
      success: false,
      message: error.message,
    });
  }
};

// ==========================================
// UPDATE PROFILE
// ==========================================

const updateProfile = async (req, res) => {
  try {
    const {
      fullName,
      phone,
      gender,
    } = req.body;

    const user = await userService.updateUserProfile({
      userId: req.user.id,
      fullName,
      phone,
      gender,
    });

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully.",
      user,
    });
  } catch (error) {
    console.error("Update profile error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};
// ==========================================
// CHANGE PASSWORD
// ==========================================

const changePassword = async (req, res) => {
  try {
    const {
      currentPassword,
      newPassword,
    } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message:
          "Current password and new password are required.",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message:
          "New password must be at least 8 characters.",
      });
    }

    await userService.changePassword({
      userId: req.user.id,
      currentPassword,
      newPassword,
    });

    return res.status(200).json({
      success: true,
      message: "Password changed successfully.",
    });
  } catch (error) {
    console.error(
      "Change password error:",
      error.message
    );

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};


// ==========================================
// DELETE ACCOUNT
// ==========================================
const deleteAccount = async (req, res) => {
  try {
    const { password } = req.body || {};

    await userService.deleteAccount({
      userId: req.user.id,
      password,
    });

    return res.status(200).json({
      success: true,
      message: "Account deleted successfully.",
    });
  } catch (error) {
    console.error("Delete account error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

module.exports = {
  getMe,
  updateProfile,
   changePassword,
  deleteAccount,
};