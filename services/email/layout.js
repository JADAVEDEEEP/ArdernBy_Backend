// KOVENIK branded e-mail layout and shared building blocks.
//
// Every customer-facing e-mail is built with renderEmail(). It returns { html, text }
// so each message always has an HTML and a plain-text version. All styles are inline and the
// layout is a single 600px table, which is what Gmail, Outlook and mobile clients handle best.
// Every dynamic value goes through esc() before it reaches the HTML.

const COLORS = {
  page: "#F2F2F0",
  card: "#FFFFFF",
  ink: "#111111",
  body: "#333333",
  muted: "#777777",
  line: "#E4E4E0",
  panel: "#F7F7F5",
  accent: "#A63A3A", // muted red, used sparingly
};

const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

// Public website address: SITE_URL (set it in production), else the current live storefront.
// Only real storefront routes are ever appended to it.
const siteUrl = () =>
  String(process.env.SITE_URL || process.env.FRONTEND_URL || "https://ardenby.vercel.app").trim().replace(/\/+$/, "");

// Public address of THIS API (API_PUBLIC_URL; the live Render service when unset).
const apiPublicUrl = () =>
  String(process.env.API_PUBLIC_URL || "https://ardernby-backend.onrender.com").trim().replace(/\/+$/, "");

// Real storefront routes (ArdenBy/app). Nothing else is linked from e-mails.
const link = {
  home: () => siteUrl() + "/",
  order: (orderId) => (orderId ? `${siteUrl()}/orders/${encodeURIComponent(orderId)}` : `${siteUrl()}/orders`),
  orders: () => `${siteUrl()}/orders`,
  membership: () => `${siteUrl()}/membership`,
  profile: () => `${siteUrl()}/profile`,
  cart: () => `${siteUrl()}/cart`,
  shop: () => `${siteUrl()}/shop`,
  contact: () => `${siteUrl()}/contact`,
  faqs: () => `${siteUrl()}/faqs`,
  shipping: () => `${siteUrl()}/shipping`,
  returns: () => `${siteUrl()}/returns`,
  newsletterUnsubscribe: (token) => `${siteUrl()}/newsletter/unsubscribe?token=${encodeURIComponent(token)}`,
  // RFC 8058 one-click target: the BACKEND address (mail providers POST to it directly).
  newsletterOneClick: (token) => `${apiPublicUrl()}/api/newsletter/unsubscribe/one-click?token=${encodeURIComponent(token)}`,
  newsletterConfirm: (token) => `${siteUrl()}/newsletter/confirm?token=${encodeURIComponent(token)}`,
  privacy: () => `${siteUrl()}/privacy`,
  terms: () => `${siteUrl()}/terms`,
};

const supportEmail = () => {
  const value = String(process.env.SUPPORT_PUBLIC_EMAIL || process.env.SUPPORT_INBOX_EMAIL || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? value : "";
};

const money = (value) =>
  "₹" + Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatDate = (value, withTime = false) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
};

// ---- HTML blocks -------------------------------------------------------------------

const paragraph = (text) =>
  `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:24px;color:${COLORS.body};">${esc(text)}</p>`;

const button = (label, url) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;"><tr>` +
  `<td align="center" bgcolor="${COLORS.ink}" style="background:${COLORS.ink};">` +
  `<a href="${esc(url)}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:${FONT};font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">${esc(label)}</a>` +
  `</td></tr></table>`;

// rows: [[label, value], ...]; empty values are skipped.
const detailTable = (rows) => {
  const live = rows.filter(([, value]) => value !== undefined && value !== null && String(value) !== "");
  if (live.length === 0) return "";
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;background:${COLORS.panel};">` +
    live
      .map(
        ([label, value], index) =>
          `<tr><td style="padding:12px 16px;font-family:${FONT};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${COLORS.muted};width:38%;vertical-align:top;${index ? `border-top:1px solid ${COLORS.line};` : ""}">${esc(label)}</td>` +
          `<td style="padding:12px 16px;font-family:${FONT};font-size:14px;color:${COLORS.ink};font-weight:600;vertical-align:top;${index ? `border-top:1px solid ${COLORS.line};` : ""}">${esc(value)}</td></tr>`
      )
      .join("") +
    `</table>`
  );
};

// Order lines + totals. lines: [{ name, size, color, quantity, unitPrice }]
const orderSummary = ({ lines = [], subtotal, discount, couponCode, shipping, tax, codFee, total }) => {
  const rows = lines
    .map((line) => {
      const details = [line.size && `Size ${line.size}`, line.color].filter(Boolean).join(" · ");
      return (
        `<tr><td style="padding:12px 0;border-bottom:1px solid ${COLORS.line};font-family:${FONT};font-size:14px;color:${COLORS.ink};">` +
        `<strong>${esc(line.name)}</strong>` +
        (details ? `<br><span style="font-size:12px;color:${COLORS.muted};">${esc(details)}</span>` : "") +
        `<br><span style="font-size:12px;color:${COLORS.muted};">Qty ${esc(line.quantity)}</span></td>` +
        `<td align="right" style="padding:12px 0;border-bottom:1px solid ${COLORS.line};font-family:${FONT};font-size:14px;color:${COLORS.ink};vertical-align:top;white-space:nowrap;">${esc(money(Number(line.unitPrice) * Number(line.quantity)))}</td></tr>`
      );
    })
    .join("");

  const totalRow = (label, value, strong) =>
    `<tr><td style="padding:${strong ? "14px 0 0" : "6px 0"};font-family:${FONT};font-size:${strong ? 15 : 13}px;color:${strong ? COLORS.ink : COLORS.muted};${strong ? "font-weight:700;" : ""}">${esc(label)}</td>` +
    `<td align="right" style="padding:${strong ? "14px 0 0" : "6px 0"};font-family:${FONT};font-size:${strong ? 15 : 13}px;color:${COLORS.ink};${strong ? "font-weight:700;" : ""}">${esc(value)}</td></tr>`;

  const totals = [
    subtotal != null ? totalRow("Subtotal", money(subtotal)) : "",
    Number(discount) > 0 ? totalRow(`Discount${couponCode ? ` (${couponCode})` : ""}`, "-" + money(discount)) : "",
    shipping != null ? totalRow("Shipping", Number(shipping) > 0 ? money(shipping) : "Free") : "",
    Number(tax) > 0 ? totalRow("GST", money(tax)) : "",
    Number(codFee) > 0 ? totalRow("COD handling fee (incl. GST)", money(codFee)) : "",
    total != null ? totalRow("Total", money(total), true) : "",
  ].join("");

  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">${rows}</table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">${totals}</table>`
  );
};

const noteBox = (text) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;"><tr>` +
  `<td style="border-left:3px solid ${COLORS.accent};padding:4px 0 4px 14px;font-family:${FONT};font-size:14px;line-height:22px;color:${COLORS.body};">${esc(text)}</td></tr></table>`;

// ---- plain-text helpers ------------------------------------------------------------

const textDetails = (rows) =>
  rows
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");

const textOrderSummary = ({ lines = [], subtotal, discount, couponCode, shipping, tax, codFee, total }) =>
  [
    "Items",
    ...lines.map((line) => {
      const details = [line.size && `Size ${line.size}`, line.color].filter(Boolean).join(", ");
      return `  - ${line.name}${details ? ` (${details})` : ""} x ${line.quantity}  ${money(Number(line.unitPrice) * Number(line.quantity))}`;
    }),
    "",
    subtotal != null ? `Subtotal: ${money(subtotal)}` : "",
    Number(discount) > 0 ? `Discount${couponCode ? ` (${couponCode})` : ""}: -${money(discount)}` : "",
    shipping != null ? `Shipping: ${Number(shipping) > 0 ? money(shipping) : "Free"}` : "",
    Number(tax) > 0 ? `GST: ${money(tax)}` : "",
    Number(codFee) > 0 ? `COD handling fee (incl. GST): ${money(codFee)}` : "",
    total != null ? `Total: ${money(total)}` : "",
  ]
    .filter((line, index, all) => line !== "" || (index > 0 && all[index - 1] !== ""))
    .join("\n");

// ---- the layout --------------------------------------------------------------------

// options:
//   preheader  - inbox preview line
//   heading    - big headline
//   intro      - plain sentence(s) above the details (string)
//   blocks     - [{ html, text }] extra content, in order
//   cta        - { label, url } primary button
//   outro      - closing sentence(s)
const renderEmail = ({ preheader = "", heading, intro = "", blocks = [], cta = null, outro = "" }) => {
  const mail = supportEmail();
  const year = new Date().getFullYear();

  const body =
    (intro ? paragraph(intro) : "") +
    blocks.map((block) => block.html).join("") +
    (cta ? button(cta.label, cta.url) : "") +
    (outro ? paragraph(outro) : "");

  const footerLinks = [
    ["Shipping", link.shipping()],
    ["Returns", link.returns()],
    ["FAQs", link.faqs()],
    ["Privacy", link.privacy()],
    ["Terms", link.terms()],
  ]
    .map(([label, url]) => `<a href="${esc(url)}" style="color:${COLORS.muted};text-decoration:underline;">${label}</a>`)
    .join(" &nbsp;·&nbsp; ");

  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">` +
    `<meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light only">` +
    `<title>${esc(heading)}</title></head>` +
    `<body style="margin:0;padding:0;background:${COLORS.page};">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${COLORS.page};">${esc(preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.page}" style="background:${COLORS.page};"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${COLORS.card};">` +
    // header
    `<tr><td align="center" style="padding:32px 24px 24px 24px;border-bottom:1px solid ${COLORS.line};">` +
    `<a href="${esc(link.home())}" style="font-family:${FONT};font-size:24px;font-weight:800;letter-spacing:8px;color:${COLORS.ink};text-decoration:none;">KOVENIK</a>` +
    `<div style="width:24px;height:2px;background:${COLORS.accent};margin:12px auto 0 auto;font-size:0;line-height:0;">&nbsp;</div>` +
    `</td></tr>` +
    // body
    `<tr><td style="padding:36px 32px 12px 32px;">` +
    `<h1 style="margin:0 0 20px 0;font-family:${FONT};font-size:26px;line-height:32px;font-weight:800;color:${COLORS.ink};letter-spacing:-0.3px;">${esc(heading)}</h1>` +
    body +
    `</td></tr>` +
    // support
    `<tr><td style="padding:0 32px 32px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${COLORS.line};"><tr><td style="padding-top:20px;font-family:${FONT};font-size:13px;line-height:20px;color:${COLORS.muted};">` +
    `Questions? ${mail ? `Write to <a href="mailto:${esc(mail)}" style="color:${COLORS.ink};">${esc(mail)}</a> or ` : ""}<a href="${esc(link.contact())}" style="color:${COLORS.ink};">contact support</a>.` +
    `</td></tr></table></td></tr>` +
    // footer
    `<tr><td align="center" bgcolor="${COLORS.panel}" style="background:${COLORS.panel};padding:24px 24px 28px 24px;font-family:${FONT};font-size:12px;line-height:20px;color:${COLORS.muted};">` +
    `<div style="font-size:14px;font-weight:800;letter-spacing:5px;color:${COLORS.ink};margin-bottom:10px;">KOVENIK</div>` +
    `<div style="margin-bottom:10px;">${footerLinks}</div>` +
    `<div>© ${year} KOVENIK. All rights reserved.</div>` +
    `</td></tr></table></td></tr></table></body></html>`;

  const text = [
    "KOVENIK",
    "",
    heading,
    "",
    intro,
    ...blocks.map((block) => block.text).filter(Boolean).flatMap((t) => ["", t]),
    cta ? `\n${cta.label}: ${cta.url}` : "",
    outro ? `\n${outro}` : "",
    "",
    "--",
    `Questions? ${mail ? `Write to ${mail} or visit ` : "Visit "}${link.contact()}`,
    `Shipping: ${link.shipping()}  Returns: ${link.returns()}  FAQs: ${link.faqs()}`,
    `© ${year} KOVENIK`,
  ]
    .filter((line, index, all) => line !== "" || (index > 0 && all[index - 1] !== ""))
    .join("\n");

  return { html, text };
};

// Block helpers keep html and text together.
const blocks = {
  details: (rows) => ({ html: detailTable(rows), text: textDetails(rows) }),
  summary: (data) => ({ html: orderSummary(data), text: textOrderSummary(data) }),
  note: (text) => ({ html: text ? noteBox(text) : "", text: text || "" }),
  paragraph: (text) => ({ html: text ? paragraph(text) : "", text: text || "" }),
  // A prominent one-time code (OTP).
  code: (value) => (!value ? { html: "", text: "" } : {
    html:
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;"><tr>` +
      `<td align="center" style="background:${COLORS.panel};padding:22px 12px;font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:${COLORS.ink};">${esc(value)}</td></tr></table>`,
    text: `Your code: ${value}`,
  }),
};

module.exports = {
  COLORS,
  esc,
  money,
  formatDate,
  siteUrl,
  link,
  supportEmail,
  renderEmail,
  blocks,
};
