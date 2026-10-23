const superAdminService = require("../services/superadmin.service");
const { publicMessage } = require("../utils/public-error");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (res, error, label) => {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(`${label}:`, error.message);

  return res.status(status).json({
    success: false,
    message: publicMessage(error, "Something went wrong. Please try again."),
  });
};

const getDashboard = async (req, res) => {
  try {
    const data = await superAdminService.getDashboard({
      days: parseInt(req.query.days, 10),
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Super admin dashboard error");
  }
};

const listUsers = async (req, res) => {
  try {
    const { search, role, status, page, limit } = req.query;
    const data = await superAdminService.listUsers({
      search: typeof search === "string" ? search : "",
      role: typeof role === "string" ? role : "",
      status: typeof status === "string" ? status : "",
      page,
      limit,
    });

    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return fail(res, error, "Super admin list users error");
  }
};

const updateUserStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { isActive } = req.body || {};

    if (!UUID.test(userId)) {
      return res.status(400).json({ success: false, message: "Invalid user id." });
    }

    if (typeof isActive !== "boolean") {
      return res.status(400).json({ success: false, message: "isActive must be true or false." });
    }

    const user = await superAdminService.setUserStatus({
      actorId: req.user.id,
      targetId: userId,
      isActive,
    });

    return res.status(200).json({ success: true, user });
  } catch (error) {
    return fail(res, error, "Super admin update status error");
  }
};

const updateUserRole = async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body || {};

    if (!UUID.test(userId)) {
      return res.status(400).json({ success: false, message: "Invalid user id." });
    }

    if (!superAdminService.ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role." });
    }

    const user = await superAdminService.setUserRole({
      actorId: req.user.id,
      targetId: userId,
      role,
    });

    return res.status(200).json({ success: true, user });
  } catch (error) {
    return fail(res, error, "Super admin update role error");
  }
};

module.exports = { getDashboard, listUsers, updateUserStatus, updateUserRole };
