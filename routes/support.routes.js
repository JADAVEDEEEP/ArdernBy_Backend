const express = require("express");

const { createSupportMessage } = require("../controller/support.controller");
const { rateLimit } = require("../middleware/security.middleware");

const supportRouter = express.Router();

// Public contact form. Tight per-IP limit: each accepted message sends an e-mail.
supportRouter.post(
  "/",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: "You have sent several messages. Please wait a few minutes and try again.",
  }),
  createSupportMessage
);

module.exports = supportRouter;
