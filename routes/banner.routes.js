const express = require("express");

const { getPublicBanners } = require("../controller/banner.controller");

const bannerRouter = express.Router();

// Public: only active banners inside their schedule, in display order.
// (Admin CRUD lives in routes/admin.routes.js under /api/admin/banners.)
bannerRouter.get("/", getPublicBanners);

module.exports = bannerRouter;
