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
const adminImages = require("../controller/admin-images.controller");
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
// AI product images: list + one-click regenerate
adminRouter.get("/images", adminImages.listProductImages);
adminRouter.post("/images/:productId/regenerate", writeLimiter, adminImages.regenerateImage);

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
adminRouter.post("/returns/:id/payout-check", writeLimiter, ops.checkReturnPayout);
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

// Newsletter subscribers: Admin and Super Admin may view, search, export and UNSUBSCRIBE (never
// re-activate). No campaign, schedule or send routes exist.
const newsletterAdmin = require("../controller/newsletter-admin.controller");
adminRouter.get("/newsletter/stats", newsletterAdmin.getStats);
adminRouter.get("/newsletter/subscribers", newsletterAdmin.listSubscribers);
adminRouter.get("/newsletter/export.csv", exportLimiter, newsletterAdmin.exportActive);
adminRouter.post("/newsletter/subscribers/:id/unsubscribe", writeLimiter, newsletterAdmin.unsubscribeSubscriber);

// Newsletter campaigns. Admin AND Super Admin: overview, list, read, create / edit DRAFTS (an Admin cannot choose
// recipients), duplicate, preview, templates, aggregate analytics. SUPER ADMIN ONLY (authorizeRoles below, checked on
// the server, not just hidden in the page): choosing recipients, test sends, scheduling, sending, cancelling, and the
// per-recipient report / CSV.
const campaignsC = require("../controller/newsletter-campaign.controller");
const superAdminOnly = authorizeRoles("superadmin");
const previewLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, keyFn: perUser, message: "Too many previews. Please wait a moment." });
const testLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 6, keyFn: perUser, message: "Too many test emails. Please wait a few minutes." });
const sendLimiter = rateLimit({ windowMs: 60 * 1000, max: 6, keyFn: perUser, message: "Too many send requests. Please wait a moment." });

adminRouter.get("/newsletter/overview", campaignsC.overview);
adminRouter.get("/newsletter/products", campaignsC.products);
adminRouter.get("/newsletter/sources", superAdminOnly, campaignsC.sources);
adminRouter.post("/newsletter/preview", previewLimiter, campaignsC.preview);

adminRouter.get("/newsletter/templates", campaignsC.listTemplates);
adminRouter.post("/newsletter/templates", writeLimiter, campaignsC.createTemplate);
adminRouter.get("/newsletter/templates/:id", campaignsC.getTemplate);
adminRouter.put("/newsletter/templates/:id", writeLimiter, campaignsC.updateTemplate);
adminRouter.delete("/newsletter/templates/:id", writeLimiter, campaignsC.deleteTemplate);

adminRouter.get("/newsletter/campaigns", campaignsC.listCampaigns);
adminRouter.post("/newsletter/campaigns", writeLimiter, campaignsC.createCampaign);
adminRouter.get("/newsletter/campaigns/:id", campaignsC.getCampaign);
adminRouter.put("/newsletter/campaigns/:id", writeLimiter, campaignsC.updateCampaign);
adminRouter.post("/newsletter/campaigns/:id/duplicate", writeLimiter, campaignsC.duplicateCampaign);
adminRouter.get("/newsletter/campaigns/:id/audience-count", superAdminOnly, campaignsC.audienceCount);
adminRouter.post("/newsletter/campaigns/:id/test", superAdminOnly, testLimiter, campaignsC.sendTest);
adminRouter.post("/newsletter/campaigns/:id/schedule", superAdminOnly, sendLimiter, campaignsC.scheduleCampaign);
adminRouter.post("/newsletter/campaigns/:id/send", superAdminOnly, sendLimiter, campaignsC.sendCampaign);
adminRouter.post("/newsletter/campaigns/:id/cancel", superAdminOnly, writeLimiter, campaignsC.cancelCampaign);
adminRouter.get("/newsletter/campaigns/:id/recipients", superAdminOnly, campaignsC.recipients);
adminRouter.get("/newsletter/campaigns/:id/report.csv", superAdminOnly, exportLimiter, campaignsC.reportCsv);

// The caller's own account security.
adminRouter.get("/security", ops.getSecurity);
adminRouter.post("/security/sign-out-everywhere", writeLimiter, ops.signOutEverywhere);

module.exports = adminRouter;
