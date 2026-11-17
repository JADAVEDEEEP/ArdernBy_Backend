const crypto = require("crypto");
const sender = require("../services/newsletter-sender.service");

// Two machine-to-machine endpoints. Neither uses a user login; each needs its own long random secret,
// and answers 503 (not 401) while that secret is not configured, so a missing setting is obvious.

const safeEqual = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

// Accepts "Authorization: Bearer <secret>", or "x-webhook-secret: <secret>". For services that can only
// call a plain URL, "?token=<secret>" is accepted too (URLs can appear in provider logs: prefer the header).
const suppliedSecret = (req) => {
  const header = req.get("authorization") || "";
  if (/^Bearer\s+\S+$/i.test(header)) return header.replace(/^Bearer\s+/i, "");
  const custom = req.get("x-webhook-secret");
  if (custom) return custom;
  return typeof req.query?.token === "string" ? req.query.token : "";
};

const guarded = (envName, notConfiguredMessage, work, label) => async (req, res) => {
  const secret = String(process.env[envName] || "").trim();
  if (secret.length < 16) {
    return res.status(503).json({ success: false, message: notConfiguredMessage });
  }
  const supplied = suppliedSecret(req);
  if (!supplied || !safeEqual(supplied, secret)) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }
  try {
    return res.status(200).json({ success: true, ...(await work(req)) });
  } catch (error) {
    console.error(`${label}:`, error.code || error.message); // never the payload, the address or a secret
    return res.status(500).json({ success: false, message: "Something went wrong." });
  }
};

// POST /api/newsletter/provider-webhook   (Brevo transactional webhook)
const providerWebhook = guarded(
  "BREVO_WEBHOOK_SECRET",
  "The delivery webhook is not configured.",
  (req) => sender.handleProviderEvents(req.body),
  "Newsletter webhook error"
);

// POST /api/newsletter/worker/tick   (called by an external scheduler to process due campaigns)
const workerTick = guarded(
  "NEWSLETTER_WORKER_SECRET",
  "The campaign worker endpoint is not configured.",
  async () => ({ tick: await sender.processTick() }),
  "Newsletter worker error"
);

module.exports = { providerWebhook, workerTick, safeEqual };
