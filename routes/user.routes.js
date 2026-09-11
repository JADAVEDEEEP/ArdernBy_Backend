const express = require("express");

const {
  getMe,
  updateProfile,
  changePassword,
  deleteAccount,
} = require("../controller/user.controller");

const {
  authenticateToken,
} = require("../middleware/auth.middleware");

const userRouter = express.Router();

// Get logged-in user
userRouter.get(
  "/me",
  authenticateToken,
  getMe
);

// Update logged-in user profile
userRouter.put(
  "/me",
  authenticateToken,
  updateProfile
);

// Change password
userRouter.put(
  "/me/password",
  authenticateToken,
  changePassword
);

// Delete account
userRouter.delete(
  "/me",
  authenticateToken,
  deleteAccount
);

module.exports = userRouter;