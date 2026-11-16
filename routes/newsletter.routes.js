const express = require("express");

const { subscribe, confirm } = require("../controller/newsletter.controller");
const { rateLimit, perEmail } = require("../middleware/security.middleware");

const newsletterRouter = express.Router();

// Public sign-up. Every accepted request can send an e-mail, so it is limited per client
// AND per address (an attacker cannot mail-bomb one inbox).
newsletterRouter.post(
  "/subscribe",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    message: "Too many sign-up attempts. Please wait a few minutes and try again.",
  }),
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    keyFn: perEmail,
    message: "That address was tried several times. Please check your inbox or try again later.",
  }),
  subscribe
);

newsletterRouter.post(
  "/confirm",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: "Too many attempts. Please wait a few minutes and try again.",
  }),
  confirm
);

module.exports = newsletterRouter;
