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

const money = (value) =>
  "₹" + Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const SIGN_OFF = "\n\nThank you for shopping with KOVENIK.\nIf you need help, just reply to this e-mail or contact support.";

const TEMPLATES = {
  cancellation_confirmed: (d) => ({
    subject: `Your KOVENIK order ${d.orderNumber} was cancelled`,
    text:
      `Hello ${d.name || "there"},\n\n` +
      `${d.whole ? "Your order" : "The items below"} ${d.whole ? d.orderNumber + " " : ""}${d.whole ? "has been cancelled" : "were cancelled from order " + d.orderNumber}.\n` +
      (d.items ? `\nItems: ${d.items}\n` : "") +
      (d.reason ? `Reason: ${d.reason}\n` : "") +
      (d.refundAmount > 0
        ? `\nA refund of ${money(d.refundAmount)} will be sent to your original payment method. We will e-mail you again when it is complete.`
        : "\nYou have not been charged for the cancelled items, so no refund is needed.") +
      SIGN_OFF,
  }),
  refund_initiated: (d) => ({
    subject: `Your refund for order ${d.orderNumber} has started`,
    text:
      `Hello ${d.name || "there"},\n\nWe have started a refund of ${money(d.amount)} for order ${d.orderNumber}. ` +
      `Banks usually take 5 to 7 working days to show it.` + SIGN_OFF,
  }),
  refund_completed: (d) => ({
    subject: `Your refund for order ${d.orderNumber} is complete`,
    text:
      `Hello ${d.name || "there"},\n\nYour refund of ${money(d.amount)} for order ${d.orderNumber} has been processed${d.method ? " (" + d.method + ")" : ""}.` +
      (d.reference ? `\nReference: ${d.reference}` : "") + SIGN_OFF,
  }),
  refund_failed: (d) => ({
    subject: `We are fixing your refund for order ${d.orderNumber}`,
    text:
      `Hello ${d.name || "there"},\n\nWe could not complete your refund of ${money(d.amount)} for order ${d.orderNumber} on the first try. ` +
      `Our team has been told and will retry it. You do not need to do anything.` + SIGN_OFF,
  }),
  return_submitted: (d) => ({
    subject: `We received your return request for order ${d.orderNumber}`,
    text:
      `Hello ${d.name || "there"},\n\nWe have received your return request for order ${d.orderNumber}.\nItems: ${d.items}\n` +
      `We will review it and e-mail you the decision.` + SIGN_OFF,
  }),
  return_approved: (d) => ({
    subject: `Your return for order ${d.orderNumber} is approved`,
    text:
      `Hello ${d.name || "there"},\n\nGood news: your return for order ${d.orderNumber} is approved.\nItems: ${d.items}\n\n` +
      `What to do next: pack the item(s) in their original condition with tags and send them back to us. ` +
      `Open your order page and tap "I have sent the items" (you can add a tracking number) so we know they are on the way.` + SIGN_OFF,
  }),
  return_rejected: (d) => ({
    subject: `About your return request for order ${d.orderNumber}`,
    text:
      `Hello ${d.name || "there"},\n\nWe are sorry, we could not accept your return request for order ${d.orderNumber}.\n` +
      `Reason: ${d.reason}` + SIGN_OFF,
  }),
  return_received: (d) => ({
    subject: `We received your returned item(s) for order ${d.orderNumber}`,
    text:
      `Hello ${d.name || "there"},\n\nYour returned item(s) for order ${d.orderNumber} have reached us. We are now checking them and will update you.` + SIGN_OFF,
  }),
  return_inspected: (d) => ({
    subject: `We finished checking your return for order ${d.orderNumber}`,
    text:
      `Hello ${d.name || "there"},\n\nWe finished checking your returned item(s) for order ${d.orderNumber}. ` +
      (d.refundable ? "We will now process your refund." : "Unfortunately none of the items qualify for a refund.") +
      (d.note ? `\nNote from our team: ${d.note}` : "") + SIGN_OFF,
  }),
  return_refund_processing: (d) => ({
    subject: `Your return refund for order ${d.orderNumber} is being processed`,
    text:
      `Hello ${d.name || "there"},\n\nYour refund of ${money(d.amount)} for the return on order ${d.orderNumber} is being processed. ` +
      `We will e-mail you when it is complete.` + SIGN_OFF,
  }),
  return_refund_completed: (d) => ({
    subject: `Your return refund for order ${d.orderNumber} is complete`,
    text:
      `Hello ${d.name || "there"},\n\nYour refund of ${money(d.amount)} for the return on order ${d.orderNumber} is complete${d.method ? " (" + d.method + ")" : ""}.` +
      (d.reference ? `\nReference: ${d.reference}` : "") + SIGN_OFF,
  }),
  return_refund_failed: (d) => ({
    subject: `We are fixing your return refund for order ${d.orderNumber}`,
    text:
      `Hello ${d.name || "there"},\n\nWe could not complete your refund of ${money(d.amount)} on the first try. ` +
      `Our team has been told and will retry it. You do not need to do anything.` + SIGN_OFF,
  }),
  // Sent once per order: for a cash-on-delivery order when it is placed, for an
  // online order only after the payment is verified. See order-email.service.js.
  order_confirmation: (d) => {
    const online = d.paymentMethod === "online";
    const placedOn = d.placedAt
      ? new Date(d.placedAt).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
    const lines = (d.lines || []).map((line) => {
      const details = [line.size && `Size ${line.size}`, line.color].filter(Boolean).join(", ");
      return `  - ${line.name}${details ? " (" + details + ")" : ""} x ${line.quantity}  ${money(line.unitPrice * line.quantity)}`;
    });
    const address = [d.shipName, d.shipPhone, d.shipAddress, [d.shipCity, d.shipState].filter(Boolean).join(", "), d.shipPincode]
      .filter(Boolean)
      .join("\n  ");

    return {
      subject: `Your KOVENIK order ${d.orderNumber} is confirmed`,
      text:
        `Hello ${d.name || "there"},\n\n` +
        `Thank you for your order. We have received it and will start getting it ready.\n\n` +
        `Order number: ${d.orderNumber}\n` +
        (placedOn ? `Placed on: ${placedOn}\n` : "") +
        `\nItems\n${lines.join("\n")}\n\n` +
        `Subtotal: ${money(d.subtotal)}\n` +
        (Number(d.discount) > 0 ? `Discount${d.couponCode ? " (" + d.couponCode + ")" : ""}: -${money(d.discount)}\n` : "") +
        `Shipping: ${Number(d.shipping) > 0 ? money(d.shipping) : "Free"}\n` +
        (Number(d.tax) > 0 ? `GST: ${money(d.tax)}\n` : "") +
        `Total: ${money(d.total)}\n\n` +
        (online
          ? `Payment: paid online. Thank you, your payment was received.\n`
          : `Payment: cash on delivery. Please keep ${money(d.total)} ready when your order arrives.\n`) +
        (address ? `\nDelivering to\n  ${address}\n` : "") +
        `\nYou can follow this order any time under My Orders on our website.` +
        SIGN_OFF,
    };
  },
};

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

module.exports = { send, notifyUser, TEMPLATES };
