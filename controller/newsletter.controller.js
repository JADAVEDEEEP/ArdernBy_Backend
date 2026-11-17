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

// POST /api/newsletter/unsubscribe  (public). Used by the unsubscribe page's button.
const unsubscribe = async (req, res) => {
  try {
    const result = await newsletter.unsubscribe(req.body?.token);
    return res.status(200).json({ success: true, message: result.message, alreadyUnsubscribed: Boolean(result.alreadyUnsubscribed) });
  } catch (error) {
    return fail(res, error, "Newsletter unsubscribe");
  }
};

// POST /api/newsletter/unsubscribe/one-click?token=...  (RFC 8058). Mail apps (Gmail, Apple Mail, Yahoo)
// call this by themselves when the reader taps "Unsubscribe", with the body "List-Unsubscribe=One-Click".
// The token is in the URL because that is the only thing the mail provider is given.
const unsubscribeOneClick = async (req, res) => {
  try {
    await newsletter.unsubscribe(typeof req.query?.token === "string" ? req.query.token : "");
    return res.status(200).json({ success: true });
  } catch (error) {
    return fail(res, error, "Newsletter one-click unsubscribe");
  }
};

// GET on the same address: a person (or an old mail client) opening the header link. Never changes
// anything; it sends them to the unsubscribe page, which asks for one click.
const unsubscribeOneClickPage = (req, res) => {
  const token = typeof req.query?.token === "string" ? req.query.token : "";
  if (!newsletter.TOKEN_SHAPE.test(token)) {
    return res.status(400).json({ success: false, message: "This unsubscribe link is not valid.", code: "TOKEN_INVALID" });
  }
  return res.redirect(302, require("../services/email/layout").link.newsletterUnsubscribe(token));
};

module.exports = { subscribe, confirm, unsubscribe, unsubscribeOneClick, unsubscribeOneClickPage };
