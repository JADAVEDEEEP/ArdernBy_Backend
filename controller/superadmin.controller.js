const superAdminService = require("../services/superadmin.service");
const confirmation = require("../services/admin-confirmation.service");
const sessionService = require("../services/session.service");
const auditService = require("../services/audit.service");
const financialReport = require("../services/financial-report.service");
const { publicMessage } = require("../utils/public-error");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (res, error, label) => {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(`${label}:`, error.message);

  return res.status(status).json({
    success: false,
    code: error.code || undefined,
    message: publicMessage(error, "Something went wrong. Please try again."),
  });
};

const str = (value) => (typeof value === "string" ? value : "");

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

// ------------------------------------------
// Activate / deactivate
// ------------------------------------------

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

    // Only for the audit entry: a failed lookup must not block the change.
    const before = await superAdminService.getAccountBrief(userId).catch(() => null);

    const user = await superAdminService.setUserStatus({
      actorId: req.user.id,
      targetId: userId,
      isActive,
    });

    // Anything the account signed in with before this moment stops working,
    // even if the account is switched back on later.
    const sessions = await sessionService.revokeAll(userId);

    await auditService.record({
      req,
      action: isActive ? "user.activate" : "user.deactivate",
      resourceType: "user",
      resourceId: userId,
      before: before ? { isActive: Boolean(before.is_active), role: before.role, email: before.email } : null,
      after: { isActive },
    });

    return res.status(200).json({ success: true, user, sessionsRevoked: sessions.revoked });
  } catch (error) {
    return fail(res, error, "Super admin update status error");
  }
};

// ------------------------------------------
// Role change: request a code, then confirm with it
// ------------------------------------------

const readRoleChange = (req) => ({
  userId: req.params.userId,
  role: str(req.body?.role),
});

const requestRoleChange = async (req, res) => {
  try {
    const { userId, role } = readRoleChange(req);

    if (!UUID.test(userId)) {
      return res.status(400).json({ success: false, message: "Invalid user id." });
    }

    const target = await superAdminService.assertRoleChangeAllowed({
      actorId: req.user.id,
      targetId: userId,
      role,
    });

    const result = await confirmation.request({
      actor: req.user,
      action: "role_change",
      targetId: userId,
      newRole: role,
      reason: req.body?.reason,
      summary: `change the role of ${target.email} from ${target.role} to ${role}`,
    });

    if (!result.emailSent) {
      return res.status(502).json({
        success: false,
        message: "The confirmation code e-mail could not be sent. Nothing was changed. Please try again.",
      });
    }

    return res.status(200).json({
      success: true,
      confirmationId: result.confirmationId,
      expiresAt: result.expiresAt,
      message: "A confirmation code was e-mailed to you.",
    });
  } catch (error) {
    return fail(res, error, "Super admin role confirmation request error");
  }
};

const describeNotification = (note) => ({
  attempted: note.attempted,
  delivered: note.delivered,
  failed: note.failed,
});

const updateUserRole = async (req, res) => {
  try {
    const { userId, role } = readRoleChange(req);
    const { confirmationId, code } = req.body || {};

    if (!UUID.test(userId)) {
      return res.status(400).json({ success: false, message: "Invalid user id." });
    }

    if (!superAdminService.ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role." });
    }

    // Same rules as the request step, re-checked now (self-change, last
    // Super Admin, unknown user ... are refused before a code is even asked for).
    const before = await superAdminService.assertRoleChangeAllowed({
      actorId: req.user.id,
      targetId: userId,
      role,
    });

    if (!confirmationId || !code) {
      return res.status(428).json({
        success: false,
        code: "CONFIRMATION_REQUIRED",
        message: "Changing a role needs a fresh confirmation code. Request one first.",
      });
    }

    // Uses the code up. From here a replay or double click is refused.
    const used = await confirmation.consume({
      id: str(confirmationId),
      code: str(code),
      actor: req.user,
      action: "role_change",
      targetId: userId,
      newRole: role,
    });

    let user;
    try {
      user = await superAdminService.setUserRole({
        actorId: req.user.id,
        targetId: userId,
        role,
      });
    } catch (error) {
      await auditService.record({
        req,
        action: "user.role_change",
        resourceType: "user",
        resourceId: userId,
        outcome: "failure",
        reason: used.reason,
        before: { role: before.role },
        after: { requestedRole: role, error: error.message },
        dedupeKey: `role_change:${confirmationId}`,
      });
      throw error;
    }

    const sessions = await sessionService.revokeAll(userId);

    await auditService.record({
      req,
      action: "user.role_change",
      resourceType: "user",
      resourceId: userId,
      reason: used.reason,
      before: { role: before.role, email: before.email },
      after: { role },
      dedupeKey: `role_change:${confirmationId}`,
    });

    const note = await confirmation.notifySuperAdmins({
      subject: "KOVENIK: a user's role was changed",
      text:
        `${req.user.email} changed the role of ${before.email} from ${before.role} to ${role}.\n` +
        `Reason given: ${used.reason}\n` +
        `Time: ${new Date().toISOString()}\n\n` +
        `If this was not expected, sign in and review the audit log immediately.`,
    });

    return res.status(200).json({
      success: true,
      user,
      sessionsRevoked: sessions.revoked,
      notification: describeNotification(note),
    });
  } catch (error) {
    return fail(res, error, "Super admin update role error");
  }
};

// ------------------------------------------
// Create an Admin (invitation by e-mail)
// ------------------------------------------

const requestAdminInvite = async (req, res) => {
  try {
    const invite = superAdminService.validateInvite(req.body || {});
    await superAdminService.assertEmailFree(invite.email);

    const result = await confirmation.request({
      actor: req.user,
      action: "admin_invite",
      targetEmail: invite.email,
      newRole: "admin",
      reason: req.body?.reason,
      summary: `create an Admin account for ${invite.email}`,
    });

    if (!result.emailSent) {
      return res.status(502).json({
        success: false,
        message: "The confirmation code e-mail could not be sent. Nothing was created. Please try again.",
      });
    }

    return res.status(200).json({
      success: true,
      confirmationId: result.confirmationId,
      expiresAt: result.expiresAt,
      message: "A confirmation code was e-mailed to you.",
    });
  } catch (error) {
    return fail(res, error, "Super admin invite request error");
  }
};

const createAdmin = async (req, res) => {
  try {
    const { confirmationId, code } = req.body || {};
    const invite = superAdminService.validateInvite(req.body || {});

    if (!confirmationId || !code) {
      return res.status(428).json({
        success: false,
        code: "CONFIRMATION_REQUIRED",
        message: "Creating an Admin needs a fresh confirmation code. Request one first.",
      });
    }

    await superAdminService.assertEmailFree(invite.email);

    const used = await confirmation.consume({
      id: str(confirmationId),
      code: str(code),
      actor: req.user,
      action: "admin_invite",
      targetEmail: invite.email,
      newRole: "admin",
    });

    const account = await superAdminService.createAdminAccount(invite);

    await auditService.record({
      req,
      action: "admin.invite",
      resourceType: "user",
      resourceId: account.id,
      reason: used.reason,
      after: { email: account.email, role: "admin" },
      dedupeKey: `admin_invite:${confirmationId}`,
    });

    const mail = await confirmation.sendMail({
      to: account.email,
      subject: "You have been invited as a KOVENIK Admin",
      text:
        `Hello ${account.fullName},\n\n` +
        `${req.user.email} has created a KOVENIK Admin account for you.\n\n` +
        `To set your own password: open the KOVENIK admin sign-in page you were given, choose "Forgot password", ` +
        `enter this e-mail address, type the 6-digit code we send you, and choose a password. ` +
        `After that you sign in with your password plus an e-mailed code each time.\n\n` +
        `If you were not expecting this, ignore this message and tell the store owner.`,
    });

    const note = await confirmation.notifySuperAdmins({
      subject: "KOVENIK: a new Admin account was created",
      text:
        `${req.user.email} created an Admin account for ${account.email}.\n` +
        `Reason given: ${used.reason}\nTime: ${new Date().toISOString()}`,
    });

    return res.status(201).json({
      success: true,
      user: { id: account.id, email: account.email, fullName: account.fullName, role: "admin" },
      inviteEmailSent: mail.ok,
      message: mail.ok
        ? "Admin account created and the invitation e-mail was sent."
        : "Admin account created, but the invitation e-mail could not be sent. Ask them to use 'Forgot password' on the admin sign-in page.",
      notification: describeNotification(note),
    });
  } catch (error) {
    return fail(res, error, "Super admin create admin error");
  }
};

// ------------------------------------------
// Audit log and financial report (read only)
// ------------------------------------------

const listAuditLogs = async (req, res) => {
  try {
    const data = await auditService.list({
      page: req.query.page,
      limit: req.query.limit,
      action: str(req.query.action),
      actor: str(req.query.actor),
      resourceType: str(req.query.resourceType),
      outcome: str(req.query.outcome),
      from: str(req.query.from),
      to: str(req.query.to),
    });
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return fail(res, error, "Super admin audit log error");
  }
};

const getFinancialReport = async (req, res) => {
  try {
    const data = await financialReport.getFinancialReport({
      from: str(req.query.from) || undefined,
      to: str(req.query.to) || undefined,
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Super admin financial report error");
  }
};

module.exports = {
  getDashboard,
  listUsers,
  updateUserStatus,
  requestRoleChange,
  updateUserRole,
  requestAdminInvite,
  createAdmin,
  listAuditLogs,
  getFinancialReport,
};
