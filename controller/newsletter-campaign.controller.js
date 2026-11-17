const campaigns = require("../services/newsletter-campaign.service");
const audit = require("../services/audit.service");
const { publicMessage } = require("../utils/public-error");

// Mounted under adminRouter (valid session + admin / superadmin role, re-read from the database on every request).
// Routes that only a Super Admin may use also carry authorizeRoles("superadmin") in routes/admin.routes.js.

const fail = (res, error, label) => {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(`${label}:`, error.code || error.message);
  return res.status(status).json({
    success: false,
    code: error.code || undefined,
    message: publicMessage(error, "Something went wrong. Please try again."),
    ...(error.currentRecipients !== undefined ? { currentRecipients: error.currentRecipients } : {}),
  });
};

const handler = (label, work) => async (req, res) => {
  try {
    return await work(req, res);
  } catch (error) {
    if (res.headersSent) return undefined; // a CSV download that already started
    return fail(res, error, label);
  }
};

const str = (value) => (typeof value === "string" ? value : "");
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
const actor = (req) => ({ ...audit.actorFrom(req), email: req.user?.email || null });

const overview = handler("Newsletter overview error", async (req, res) =>
  res.status(200).json({ success: true, overview: await campaigns.overview() })
);

const products = handler("Newsletter product search error", async (req, res) =>
  res.status(200).json({ success: true, products: await campaigns.searchProducts(str(req.query.search)) })
);

const sources = handler("Newsletter sources error", async (req, res) =>
  res.status(200).json({ success: true, sources: await campaigns.signupSources() })
);

const preview = handler("Newsletter preview error", async (req, res) => {
  const b = body(req);
  const result = await campaigns.preview({ design: b.design, subject: b.subject, preheader: b.preheader });
  return res.status(200).json({ success: true, ...result });
});

// ---- campaigns ----
const listCampaigns = handler("Newsletter campaign list error", async (req, res) =>
  res.status(200).json({
    success: true,
    ...(await campaigns.list({ page: req.query.page, limit: req.query.limit, status: str(req.query.status), search: str(req.query.search) })),
  })
);

const getCampaign = handler("Newsletter campaign read error", async (req, res) =>
  res.status(200).json({ success: true, campaign: await campaigns.get(req.params.id, req.user) })
);

const createCampaign = handler("Newsletter campaign create error", async (req, res) =>
  res.status(201).json({ success: true, campaign: await campaigns.create(body(req), actor(req)) })
);

const updateCampaign = handler("Newsletter campaign update error", async (req, res) =>
  res.status(200).json({ success: true, campaign: await campaigns.update(req.params.id, body(req), actor(req)) })
);

const duplicateCampaign = handler("Newsletter campaign duplicate error", async (req, res) =>
  res.status(201).json({ success: true, campaign: await campaigns.duplicate(req.params.id, actor(req)) })
);

const audienceCount = handler("Newsletter audience count error", async (req, res) =>
  res.status(200).json({ success: true, ...(await campaigns.audienceCount(req.params.id)) })
);

const sendTest = handler("Newsletter test send error", async (req, res) => {
  const result = await campaigns.sendTest(req.params.id, { to: body(req).to }, actor(req));
  return res.status(200).json({ success: true, message: `Test email sent to ${result.sent} address${result.sent === 1 ? "" : "es"}.`, ...result });
});

const scheduleCampaign = handler("Newsletter schedule error", async (req, res) =>
  res.status(200).json({
    success: true,
    campaign: await campaigns.schedule(
      req.params.id,
      { scheduledAt: body(req).scheduledAt, confirm: body(req).confirm, expectedRecipients: body(req).expectedRecipients },
      actor(req)
    ),
  })
);

const sendCampaign = handler("Newsletter send error", async (req, res) =>
  res.status(202).json({
    success: true,
    campaign: await campaigns.send(req.params.id, { confirm: body(req).confirm, expectedRecipients: body(req).expectedRecipients }, actor(req)),
  })
);

const cancelCampaign = handler("Newsletter cancel error", async (req, res) =>
  res.status(200).json({ success: true, campaign: await campaigns.cancel(req.params.id, actor(req)) })
);

const recipients = handler("Newsletter recipient report error", async (req, res) =>
  res.status(200).json({
    success: true,
    ...(await campaigns.recipientReport(req.params.id, { page: req.query.page, limit: req.query.limit, status: str(req.query.status) })),
  })
);

const reportCsv = handler("Newsletter report export error", async (req, res) =>
  campaigns.streamReportCsv({ res, id: req.params.id, actor: actor(req) })
);

// ---- templates ----
const listTemplates = handler("Newsletter template list error", async (req, res) =>
  res.status(200).json({ success: true, templates: await campaigns.listTemplates() })
);
const getTemplate = handler("Newsletter template read error", async (req, res) =>
  res.status(200).json({ success: true, template: await campaigns.getTemplate(req.params.id) })
);
const createTemplate = handler("Newsletter template create error", async (req, res) =>
  res.status(201).json({ success: true, template: await campaigns.saveTemplate(undefined, body(req), actor(req)) })
);
const updateTemplate = handler("Newsletter template update error", async (req, res) =>
  res.status(200).json({ success: true, template: await campaigns.saveTemplate(req.params.id, body(req), actor(req)) })
);
const deleteTemplate = handler("Newsletter template delete error", async (req, res) => {
  await campaigns.deleteTemplate(req.params.id, actor(req));
  return res.status(200).json({ success: true, message: "Template deleted." });
});

module.exports = {
  overview, products, sources, preview,
  listCampaigns, getCampaign, createCampaign, updateCampaign, duplicateCampaign,
  audienceCount, sendTest, scheduleCampaign, sendCampaign, cancelCampaign, recipients, reportCsv,
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
};
