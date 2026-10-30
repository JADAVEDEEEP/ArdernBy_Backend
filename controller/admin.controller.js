const analyticsService = require("../services/analytics.service");
const settingsService = require("../services/settings.service");
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

const getAnalytics = async (req, res) => {
  try {
    const { from, to, compare } = req.query;
    const data = await analyticsService.getAnalytics({ from, to, compare });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Analytics error");
  }
};

const getSettings = async (req, res) => {
  try {
    const data = await settingsService.getAllSettings();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Get settings error");
  }
};

// Sections only the owner (Super Admin) may change.
const SUPERADMIN_ONLY_SECTIONS = ["returns"];

const updateSettings = async (req, res) => {
  try {
    if (
      SUPERADMIN_ONLY_SECTIONS.includes(req.params.section) &&
      req.user.role !== "superadmin"
    ) {
      return res.status(403).json({
        success: false,
        message: "Only a Super Admin can change this setting.",
      });
    }

    let before = null;
    try {
      before = (await settingsService.getAllSettings()).settings[req.params.section] || null;
    } catch {
      // The update below reports any real problem; this is only for the log.
    }

    const settings = await settingsService.updateSection(
      req.params.section,
      req.body,
      req.user.id
    );

    await audit.record({
      req,
      action: "settings.update",
      resourceType: "settings",
      resourceId: req.params.section,
      before,
      after: settings,
    });
    return res.status(200).json({
      success: true,
      message: "Settings saved.",
      settings,
    });
  } catch (error) {
    return fail(res, error, "Update settings error");
  }
};

const getAlerts = async (req, res) => {
  try {
    const alerts = await settingsService.getAlerts();
    return res.status(200).json({ success: true, alerts });
  } catch (error) {
    return fail(res, error, "Get alerts error");
  }
};

module.exports = { getAnalytics, getSettings, updateSettings, getAlerts };
