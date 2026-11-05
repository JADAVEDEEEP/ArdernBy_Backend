const support = require("../services/support.service");

// POST /api/support  (public: guests and signed-in customers)
const createSupportMessage = async (req, res) => {
  try {
    // Hidden "website" field: real people leave it empty. Bots get a silent success.
    if (typeof req.body?.website === "string" && req.body.website.trim()) {
      return res.status(201).json({ success: true, message: "Thanks, your message has been sent." });
    }
    await support.submit(req.body);
    return res.status(201).json({ success: true, message: "Thanks, your message has been sent." });
  } catch (error) {
    const status = error.statusCode || 500;
    if (!error.statusCode) console.error("Support error:", error.message);
    return res.status(status).json({
      success: false,
      message: error.statusCode ? error.message : "Something went wrong. Please try again.",
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

module.exports = { createSupportMessage };
