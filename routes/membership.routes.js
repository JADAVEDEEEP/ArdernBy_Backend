const express = require("express");
const c = require("../controller/membership.controller");
const { authenticateToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { rateLimit, perUser } = require("../middleware/security.middleware");

const membershipRouter = express.Router();

// Anyone can browse the plans.
membershipRouter.get("/plans", c.getPlans);
// Entry-tier price per product, for guests / non-members (display only).
membershipRouter.get("/preview-pricing", rateLimit({ windowMs: 60 * 1000, max: 60, message: "Too many requests. Please wait a moment." }), c.getPreviewPricing);

// Everything else needs a signed-in customer.
const customerOnly = [authenticateToken, authorizeRoles("customer")];
const payLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyFn: perUser,
  message: "Too many payment requests. Please wait a moment and try again.",
});

membershipRouter.get("/my", ...customerOnly, c.getMy);
membershipRouter.get("/my-pricing", ...customerOnly, c.getMyPricing);
membershipRouter.put("/birthday", ...customerOnly, c.birthday);
membershipRouter.post("/purchase", ...customerOnly, payLimiter, c.purchase);
membershipRouter.post("/verify", ...customerOnly, payLimiter, c.verify);
membershipRouter.post("/failed", ...customerOnly, payLimiter, c.failed);
membershipRouter.post("/sync", ...customerOnly, payLimiter, c.sync);

module.exports = membershipRouter;
