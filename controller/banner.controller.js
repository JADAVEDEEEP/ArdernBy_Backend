const bannerService = require("../services/banner.service");
const audit = require("../services/audit.service");
const { publicMessage } = require("../utils/public-error");

const fail = (res, error, label) => {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(`${label}:`, error.message);

  return res.status(status).json({
    success: false,
    message: publicMessage(error, "Something went wrong. Please try again."),
  });
};

const handler = (label, work) => async (req, res) => {
  try {
    return await work(req, res);
  } catch (error) {
    return fail(res, error, label);
  }
};

const filesOf = (req) => ({
  image: req.files?.image?.[0],
  mobileImage: req.files?.mobileImage?.[0],
});

const body = (req) => (req.body && typeof req.body === "object" ? req.body : {});

// Public: banners that are active and inside their start / end window.
const getPublicBanners = handler("Get banners error", async (req, res) => {
  const banners = await bannerService.listPublic();
  return res.status(200).json({ success: true, banners });
});

const listBanners = handler("Admin list banners error", async (req, res) => {
  const banners = await bannerService.listAdmin();
  return res.status(200).json({ success: true, banners });
});

const createBanner = handler("Admin create banner error", async (req, res) => {
  const banner = await bannerService.create(body(req), filesOf(req));

  await audit.record({
    req,
    action: "banner.create",
    resourceType: "banner",
    resourceId: banner.id,
    after: banner,
  });

  return res.status(201).json({ success: true, message: "Banner created.", banner });
});

const updateBanner = handler("Admin update banner error", async (req, res) => {
  const { before, after } = await bannerService.update(req.params.id, body(req), filesOf(req));

  await audit.record({
    req,
    action: "banner.update",
    resourceType: "banner",
    resourceId: after.id,
    before,
    after,
  });

  return res.status(200).json({ success: true, message: "Banner updated.", banner: after });
});

const setBannerActive = handler("Admin banner active error", async (req, res) => {
  const { before, after } = await bannerService.setActive(req.params.id, body(req).active);

  await audit.record({
    req,
    action: after.active ? "banner.activate" : "banner.deactivate",
    resourceType: "banner",
    resourceId: after.id,
    before,
    after,
  });

  return res.status(200).json({
    success: true,
    message: after.active ? "Banner activated." : "Banner deactivated.",
    banner: after,
  });
});

const deleteBanner = handler("Admin delete banner error", async (req, res) => {
  const before = await bannerService.remove(req.params.id);

  await audit.record({
    req,
    action: "banner.delete",
    resourceType: "banner",
    resourceId: before.id,
    before,
  });

  return res.status(200).json({ success: true, message: "Banner deleted." });
});

module.exports = {
  getPublicBanners,
  listBanners,
  createBanner,
  updateBanner,
  setBannerActive,
  deleteBanner,
};
