const admin = require("../services/newsletter-admin.service");
const audit = require("../services/audit.service");
const { publicMessage } = require("../utils/public-error");

// Mounted under adminRouter, which already requires a valid session and an admin or superadmin
// role (re-read from the database on every request). Admin and Super Admin have the same rights here.

const fail = (res, error, label) => {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(`${label}:`, error.message);
  return res.status(status).json({
    success: false,
    code: error.code || undefined,
    message: publicMessage(error, "Something went wrong. Please try again."),
  });
};

const handler = (label, work) => async (req, res) => {
  try {
    return await work(req, res);
  } catch (error) {
    // A CSV download that already started cannot be turned into JSON.
    if (res.headersSent) return undefined;
    return fail(res, error, label);
  }
};

const str = (value) => (typeof value === "string" ? value : "");

const getStats = handler("Admin newsletter stats error", async (req, res) => {
  const stats = await admin.stats();
  return res.status(200).json({ success: true, stats });
});

const listSubscribers = handler("Admin newsletter list error", async (req, res) => {
  const filters = {
    page: req.query.page,
    limit: req.query.limit,
    status: str(req.query.status),
    search: str(req.query.search),
  };
  const data = await admin.list(filters);
  await admin.recordListView({
    actor: audit.actorFrom(req),
    status: filters.status,
    search: filters.search,
    page: data.pagination.page,
    total: data.pagination.total,
  });
  return res.status(200).json({ success: true, ...data });
});

// POST /api/admin/newsletter/subscribers/:id/unsubscribe   { confirm: true, reason }
const unsubscribeSubscriber = handler("Admin newsletter unsubscribe error", async (req, res) => {
  const result = await admin.adminUnsubscribe({
    id: str(req.params.id),
    reason: req.body?.reason,
    confirm: req.body?.confirm,
    actor: audit.actorFrom(req),
  });
  return res.status(200).json({
    success: true,
    status: result.status,
    alreadyUnsubscribed: result.alreadyUnsubscribed,
    changed: result.changed,
    message: result.changed
      ? "Subscriber unsubscribed."
      : result.alreadyUnsubscribed
        ? "This subscriber is already unsubscribed."
        : `No change: this subscriber's status is "${result.status}" and they already cannot receive marketing email.`,
  });
});

const exportActive = handler("Admin newsletter export error", async (req, res) =>
  admin.streamActiveCsv({ res, actor: audit.actorFrom(req) })
);

module.exports = { getStats, listSubscribers, exportActive, unsubscribeSubscriber };
