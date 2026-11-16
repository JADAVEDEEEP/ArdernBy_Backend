const newsletter = require("../services/newsletter.service");

const SUCCESS_TEXT = "Almost there! Check your inbox for a confirmation email to finish joining.";

const fail = (res, error, label) => {
  const status = error.statusCode || 500;
  if (!error.statusCode) console.error(`${label} error:`, error.message);
  return res.status(status).json({
    success: false,
    message: error.statusCode ? error.message : "Something went wrong. Please try again.",
    ...(error.code ? { code: error.code } : {}),
  });
};

// POST /api/newsletter/subscribe  (public)
const subscribe = async (req, res) => {
  try {
    // Hidden "website" field: real people leave it empty. Bots get a silent success.
    if (typeof req.body?.website === "string" && req.body.website.trim()) {
      return res.status(200).json({ success: true, message: SUCCESS_TEXT });
    }
    const result = await newsletter.subscribe(req.body, {
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });
    return res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    return fail(res, error, "Newsletter subscribe");
  }
};

// POST /api/newsletter/confirm  (public). POST, not GET, so mail scanners that
// pre-fetch links in an e-mail cannot confirm an address by accident.
const confirm = async (req, res) => {
  try {
    const result = await newsletter.confirm(req.body?.token);
    return res.status(200).json({ success: true, message: result.message, alreadyConfirmed: Boolean(result.alreadyConfirmed) });
  } catch (error) {
    return fail(res, error, "Newsletter confirm");
  }
};

module.exports = { subscribe, confirm };
