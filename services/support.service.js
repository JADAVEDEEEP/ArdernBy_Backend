const { poolPromise } = require("../config/sql");
const { transporter, getBrevoSender } = require("../config/mailer");

// ==========================================
// CUSTOMER SUPPORT MESSAGES (contact form)
//
// No database table: a valid message is e-mailed to the support inbox with the
// customer's address as Reply-To. The inbox is NEVER hard-coded:
//   1. SUPPORT_INBOX_EMAIL (environment), else
//   2. store_settings -> store.supportEmail (Admin -> Settings), else
//   3. the request is refused with 503 and nothing is pretended.
// ==========================================

const httpError = (statusCode, message, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const LIMITS = { name: 80, email: 254, orderNumber: 40, subject: 120, message: 2000 };
const MIN_MESSAGE = 10;

const oneLine = (value, max) =>
  typeof value === "string" ? value.normalize("NFC").replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, max) : "";

const multiLine = (value, max) =>
  typeof value === "string"
    ? value.normalize("NFC").replace(/\r\n?/g, "\n").replace(CONTROL, "").trim().slice(0, max)
    : "";

// Returns the cleaned fields, or throws a 400 that names the first problem.
const validate = (input = {}) => {
  const name = oneLine(input.name, LIMITS.name);
  const email = oneLine(input.email, LIMITS.email).toLowerCase();
  const orderNumber = oneLine(input.orderNumber, LIMITS.orderNumber);
  const subject = oneLine(input.subject, LIMITS.subject);
  const message = multiLine(input.message, LIMITS.message);

  if (!name) throw httpError(400, "Please enter your name.", "NAME_REQUIRED");
  if (!email || !EMAIL.test(email)) throw httpError(400, "Please enter a valid email address.", "EMAIL_INVALID");
  if (orderNumber && !/^[A-Za-z0-9#\-_ ]{3,40}$/.test(orderNumber)) {
    throw httpError(400, "That order number does not look right.", "ORDER_INVALID");
  }
  if (!subject) throw httpError(400, "Please add a subject.", "SUBJECT_REQUIRED");
  if (message.length < MIN_MESSAGE) {
    throw httpError(400, `Please write at least ${MIN_MESSAGE} characters in your message.`, "MESSAGE_SHORT");
  }
  return { name, email, orderNumber, subject, message };
};

const defaultRecipient = async () => {
  const fromEnv = (process.env.SUPPORT_INBOX_EMAIL || "").trim();
  if (EMAIL.test(fromEnv)) return fromEnv;
  try {
    const pool = await poolPromise;
    const [rows] = await pool.execute("SELECT value FROM store_settings WHERE section = 'store' LIMIT 1");
    const stored = rows[0] ? JSON.parse(rows[0].value) : {};
    const configured = typeof stored.supportEmail === "string" ? stored.supportEmail.trim() : "";
    return EMAIL.test(configured) ? configured : null;
  } catch {
    return null;
  }
};

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const submit = async (input, deps = {}) => {
  const fields = validate(input);
  const getRecipient = deps.getRecipient || defaultRecipient;
  const sendMail = deps.sendMail || ((mail) => transporter.sendMail(mail));
  const sender = deps.sender || getBrevoSender;

  const to = await getRecipient();
  if (!to) {
    throw httpError(503, "Our support inbox is not available right now. Please try again later.", "SUPPORT_NOT_CONFIGURED");
  }

  const { from, envelopeFrom } = sender();
  const lines = [
    `Name: ${fields.name}`,
    `Email: ${fields.email}`,
    `Order number: ${fields.orderNumber || "not given"}`,
    "",
    fields.message,
  ];

  try {
    await sendMail({
      from,
      envelope: { from: envelopeFrom, to },
      to,
      replyTo: { name: fields.name, address: fields.email },
      subject: `[KOVENIK support] ${fields.subject}`,
      text: lines.join("\n"),
      html:
        `<p><strong>Name:</strong> ${escapeHtml(fields.name)}<br>` +
        `<strong>Email:</strong> ${escapeHtml(fields.email)}<br>` +
        `<strong>Order number:</strong> ${escapeHtml(fields.orderNumber || "not given")}</p>` +
        `<p>${escapeHtml(fields.message).replace(/\n/g, "<br>")}</p>`,
    });
  } catch (error) {
    console.error("Support e-mail failed:", error.code || error.message);
    throw httpError(502, "We could not send your message. Please try again in a moment.", "SUPPORT_SEND_FAILED");
  }

  return { received: true };
};

module.exports = { validate, submit, LIMITS, MIN_MESSAGE };
