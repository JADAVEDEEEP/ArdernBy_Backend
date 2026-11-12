const notifications = require("./notification.service");

// ==========================================
// MEMBERSHIP E-MAILS
//
// Purchase / renewal / failed-payment mails are triggered from membership.service. The
// "ending soon" and "ended" mails are found by the periodic sweep. Every message carries a
// dedupe key, so the sweep running every 30 minutes, webhook retries and double submits can
// never send the same mail twice. Nothing here throws or blocks a membership change.
// ==========================================

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_DAYS = 7;
const EXPIRED_LOOKBACK_DAYS = 3;

const notifyMembership = (userId, { dedupeKey, template, data }) => {
  try {
    Promise.resolve(notifications.notifyUser({ userId, dedupeKey, template, data })).catch(() => {});
  } catch (_) {
    // never let an e-mail problem reach a membership change
  }
};

// A customer who still has another running or queued term has not lost their membership.
const hasOtherTerm = async (pool, userId, excludeId, now) => {
  const [rows] = await pool.execute(
    "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' AND end_date > ? AND id <> ? LIMIT 1",
    [userId, now, excludeId]
  );
  return rows.length > 0;
};

const membershipLifecycle = async (pool, now = new Date()) => {
  try {
    const soon = new Date(now.getTime() + REMINDER_DAYS * DAY_MS);
    const [ending] = await pool.execute(
      "SELECT id, user_id, end_date FROM subscriptions WHERE status = 'active' AND end_date > ? AND end_date <= ?",
      [now, soon]
    );
    for (const row of ending) {
      if (await hasOtherTerm(pool, row.user_id, row.id, now)) continue; // renewal already queued
      notifyMembership(row.user_id, {
        dedupeKey: `membership-expiring:${row.id}`,
        template: "membership_expiring",
        data: { endDate: row.end_date },
      });
    }

    const since = new Date(now.getTime() - EXPIRED_LOOKBACK_DAYS * DAY_MS);
    const [ended] = await pool.execute(
      "SELECT id, user_id, end_date FROM subscriptions WHERE status = 'expired' AND end_date <= ? AND end_date > ?",
      [now, since]
    );
    for (const row of ended) {
      if (await hasOtherTerm(pool, row.user_id, row.id, now)) continue;
      notifyMembership(row.user_id, {
        dedupeKey: `membership-expired:${row.id}`,
        template: "membership_expired",
        data: { endDate: row.end_date },
      });
    }
  } catch (error) {
    console.error("Membership e-mail sweep failed:", error.code || error.message);
  }
};

module.exports = { notifyMembership, membershipLifecycle };
