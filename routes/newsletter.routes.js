const express = require("express");

const { subscribe, confirm, unsubscribe, unsubscribeOneClick, unsubscribeOneClickPage } = require("../controller/newsletter.controller");
const { rateLimit, perEmail } = require("../middleware/security.middleware");
const { TOKEN_SHAPE } = require("../services/newsletter.service");

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

const unsubscribeLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many attempts. Please wait a few minutes and try again.",
});

// The page button: one person on their own connection, so a per-IP limit fits.
newsletterRouter.post("/unsubscribe", unsubscribeLimit, unsubscribe);

// RFC 8058 one-click. Gmail, Yahoo and Apple call this from a handful of shared proxy IPs, one
// request per recipient, so a tight per-IP limit would refuse real unsubscribes at campaign scale
// (an unsubscribe that fails is a compliance problem). Protection that does not depend on the IP:
//   * the token is 256-bit random and single-use, so guessing is not feasible;
//   * a malformed token is rejected before any database work;
//   * per TOKEN: a few attempts per 15 minutes (a mail provider retries a token only a couple of times);
//   * per IP: a high flood ceiling that no legitimate provider reaches, but bounds a DoS.
const clientKey = (req) => `ip:${req.ip || req.socket?.remoteAddress || "unknown"}`;
const oneClickFloodCeiling = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  keyFn: clientKey,
  message: "Too many requests. Please try again later.",
});
const oneClickPerToken = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  // Only well-formed tokens are counted per token; malformed ones fail the shape check for free
  // and still count toward the per-IP ceiling above.
  keyFn: (req) =>
    typeof req.query?.token === "string" && TOKEN_SHAPE.test(req.query.token) ? `tok:${req.query.token}` : null,
  message: "Too many requests for this link.",
});

// Mail providers send a form-encoded body, which the app-wide JSON parser skips.
newsletterRouter.post(
  "/unsubscribe/one-click",
  oneClickFloodCeiling,
  oneClickPerToken,
  express.urlencoded({ extended: false, limit: "1kb" }),
  unsubscribeOneClick
);
newsletterRouter.get("/unsubscribe/one-click", oneClickFloodCeiling, unsubscribeOneClickPage);

// ---- machine endpoints (secret protected, no user login) ----
// Brevo calls the webhook from a few IPs, one request per event, so it gets a generous per-IP ceiling here
// (and is skipped by the app-wide 300/minute limit in app.js). The secret is what protects it.
const { providerWebhook, workerTick } = require("../controller/newsletter-worker.controller");
newsletterRouter.post(
  "/provider-webhook",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 3000, keyFn: clientKey, message: "Too many requests." }),
  providerWebhook
);
newsletterRouter.post(
  "/worker/tick",
  rateLimit({ windowMs: 60 * 1000, max: 20, keyFn: clientKey, message: "Too many requests." }),
  workerTick
);

module.exports = newsletterRouter;
