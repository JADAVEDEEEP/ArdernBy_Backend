const { poolPromise } = require("../config/sql");
const { transporter, getBrevoSender } = require("../config/mailer");

// ==========================================
// CUSTOMER NOTIFICATIONS (e-mail)
//
// Reuses the existing mail setup (config/mailer.js). Every message has a
// dedupe key (e.g. "return-approved:<return id>"). The key is claimed in
// `notification_log` BEFORE sending, so a retried request or a repeated
// Razorpay webhook cannot send the same e-mail twice. A message that failed to
// send can be claimed again by a later attempt.
//
// send() never throws: an e-mail problem must never undo a cancellation, a
// return step or a refund that already happened. Failures are logged and
// recorded as "failed".
// ==========================================

const isMissingTable = (error) =>
  Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);

const { TEMPLATES } = require("./email/templates");

// Claims the dedupe key. true = this caller must send it.
const claim = async (pool, dedupeKey, to, template) => {
  const [inserted] = await pool.execute(
    `
      INSERT IGNORE INTO notification_log
        (dedupe_key, recipient, template, status, created_at, updated_at)
      VALUES (?, ?, ?, 'sending', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
    `,
    [dedupeKey, to, template]
  );
  if (inserted.affectedRows === 1) return true;

  // Already known. Only a message that FAILED before may be tried again.
  const [retry] = await pool.execute(
    "UPDATE notification_log SET status = 'sending', updated_at = UTC_TIMESTAMP(6) WHERE dedupe_key = ? AND status = 'failed'",
    [dedupeKey]
  );
  return retry.affectedRows === 1;
};

const send = async ({ dedupeKey, to, template, data }) => {
  try {
    const build = TEMPLATES[template];
    if (!build) throw new Error(`Unknown notification template ${template}`);
    if (!to || /@deleted\.ardenby\.local$/i.test(to)) return { sent: false, skipped: "no_recipient" };

    const pool = await poolPromise;
    let mine;
    try {
      mine = await claim(pool, dedupeKey, to, template);
    } catch (error) {
      if (isMissingTable(error)) {
        // Without the log we cannot guarantee "once only", so we do not send.
        console.warn("Notification skipped (apply admin_controls_phase3):", template);
        return { sent: false, skipped: "not_available" };
      }
      throw error;
    }
    if (!mine) return { sent: false, duplicate: true };

    const message = build(data || {});
    try {
      const sender = getBrevoSender();
      await transporter.sendMail({
        from: sender.from,
        envelope: { from: sender.envelopeFrom, to },
        to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      await pool.execute(
        "UPDATE notification_log SET status = 'sent', error = NULL, updated_at = UTC_TIMESTAMP(6) WHERE dedupe_key = ?",
        [dedupeKey]
      );
      return { sent: true };
    } catch (error) {
      console.error("Customer e-mail failed:", template, "|", error.code || error.message);
      await pool
        .execute(
          "UPDATE notification_log SET status = 'failed', error = ?, updated_at = UTC_TIMESTAMP(6) WHERE dedupe_key = ?",
          [String(error.code || error.message).slice(0, 200), dedupeKey]
        )
        .catch(() => {});
      return { sent: false, failed: true };
    }
  } catch (error) {
    console.error("Notification error:", template, "|", error.code || error.message);
    return { sent: false, failed: true };
  }
};

// Looks the customer up and sends. `data` gets the customer's name added.
const notifyUser = async ({ userId, dedupeKey, template, data }) => {
  try {
    const pool = await poolPromise;
    const [rows] = await pool.execute("SELECT email, full_name FROM profiles WHERE id = ? LIMIT 1", [userId]);
    if (!rows[0]) return { sent: false, skipped: "no_recipient" };
    return await send({
      dedupeKey,
      to: rows[0].email,
      template,
      data: { name: rows[0].full_name ? String(rows[0].full_name).split(" ")[0] : "", ...data },
    });
  } catch (error) {
    console.error("Notification lookup failed:", template, "|", error.code || error.message);
    return { sent: false, failed: true };
  }
};

// Sends one branded e-mail straight away (no dedupe log) and THROWS on failure. For messages
// that are unique by nature and where the caller must know it failed (one-time codes).
const deliver = async ({ to, template, data }) => {
  const build = TEMPLATES[template];
  if (!build) throw new Error(`Unknown notification template ${template}`);
  const message = build(data || {});
  const sender = getBrevoSender();
  await transporter.sendMail({
    from: sender.from,
    envelope: { from: sender.envelopeFrom, to },
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
};

module.exports = { send, notifyUser, deliver, TEMPLATES };
