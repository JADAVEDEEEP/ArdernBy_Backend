const refundSync = require("../controller/refund-sync.controller");
const express = require("express");

const {
  getAnalytics,
  getSettings,
  updateSettings,
  getAlerts,
} = require("../controller/admin.controller");
const ops = require("../controller/admin-ops.controller");
const banners = require("../controller/banner.controller");
const upload = require("../middleware/upload.middleware");

const { authenticateToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { rateLimit, perUser } = require("../middleware/security.middleware");

const adminRouter = express.Router();

// Everything here needs a valid session and an admin / superadmin role, which
// authenticateToken re-reads from the database on every request.
adminRouter.use(authenticateToken, authorizeRoles("admin", "superadmin"));

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: perUser,
  message: "Too many requests. Please wait a moment and try again.",
});

adminRouter.get("/analytics", getAnalytics);
adminRouter.get("/settings", getSettings);
adminRouter.put("/settings/:section", writeLimiter, updateSettings);
adminRouter.get("/alerts", getAlerts);

// Review moderation (hide / unhide, reason required, audited).
adminRouter.get("/reviews", ops.listReviews);
adminRouter.patch("/reviews/:reviewId/moderation", writeLimiter, ops.moderateReview);

// Returns.
adminRouter.get("/returns", ops.listReturns);
adminRouter.get("/returns/:id", ops.getReturn);
adminRouter.patch("/returns/:id/decision", writeLimiter, ops.decideReturn);
adminRouter.patch("/returns/:id/shipped", writeLimiter, ops.shipReturn);
adminRouter.patch("/returns/:id/receive", writeLimiter, ops.receiveReturn);
adminRouter.patch("/returns/:id/inspect", writeLimiter, ops.inspectReturn);
adminRouter.post("/returns/:id/refund", writeLimiter, ops.refundReturn);
adminRouter.post("/returns/:id/refund-retry", writeLimiter, ops.retryReturnRefund);
adminRouter.post("/returns/:id/refund-check", writeLimiter, refundSync.checkReturn);
adminRouter.get("/returns-options", ops.returnOptions);
adminRouter.get("/reports/returns", ops.returnsAnalytics);

// Homepage banners (table editorial_banners). Images: "image" (desktop,
// required on create) and "mobileImage" (optional portrait artwork).
const bannerImages = [
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "mobileImage", maxCount: 1 },
  ]),
  upload.verifyImageSignatures,
];
adminRouter.get("/banners", banners.listBanners);
adminRouter.post("/banners", writeLimiter, ...bannerImages, banners.createBanner);
adminRouter.put("/banners/:id", writeLimiter, ...bannerImages, banners.updateBanner);
adminRouter.patch("/banners/:id/active", writeLimiter, banners.setBannerActive);
adminRouter.delete("/banners/:id", writeLimiter, banners.deleteBanner);

// Membership plans, purchases, product rules and manual status changes (audited).
const membership = require("../controller/membership.controller");
adminRouter.get("/membership/plans", membership.adminPlans);
adminRouter.post("/membership/plans", writeLimiter, membership.adminCreatePlan);
adminRouter.put("/membership/plans/:id", writeLimiter, membership.adminUpdatePlan);
adminRouter.get("/membership/plans/:id/products", membership.adminRules);
adminRouter.put("/membership/plans/:id/products/:productId", writeLimiter, membership.adminSetRule);
adminRouter.put("/membership/settings", writeLimiter, membership.adminSettings);
adminRouter.get("/membership/purchases", membership.adminPurchases);
adminRouter.post("/membership/purchases/:id/status", writeLimiter, membership.adminStatus);

// Inventory history (read only).
adminRouter.get("/inventory/movements", ops.listInventoryMovements);

// Orders CSV. Operational columns only; customer details need a Super Admin.
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  keyFn: perUser,
  message: "Too many exports. Please wait a moment and try again.",
});
adminRouter.get("/exports/orders.csv", exportLimiter, ops.exportOrders);

// The caller's own account security.
adminRouter.get("/security", ops.getSecurity);
adminRouter.post("/security/sign-out-everywhere", writeLimiter, ops.signOutEverywhere);

module.exports = adminRouter;
