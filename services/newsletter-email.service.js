const { esc, siteUrl, COLORS: BRAND } = require("./email/layout");

// ==========================================
// NEWSLETTER E-MAIL DESIGN: validation + rendering (pure, no database, no network)
//
// A campaign design is JSON: { style, blocks[] }. Admins never write raw HTML. Every text value is
// length-limited and HTML-escaped when rendered, every link / image must be an https URL (or a site
// path), colours must be #RRGGBB, and fonts / sizes / spacing come from fixed lists. That is the HTML
// sanitisation: nothing an admin types can become a script, an event handler or a tracking pixel of
// their choosing.
//
// The compliance footer (why you got this, a visible unsubscribe link, the postal address) is ALWAYS
// appended by the renderer. It is not a block, so it cannot be deleted from a design.
// ==========================================

const MAX_BLOCKS = 40;
const MAX_DESIGN_JSON = 60 * 1024;
const UNSUBSCRIBE_PLACEHOLDER = "{{unsubscribe_url}}";

const httpError = (statusCode, message, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};
const invalid = (message) => httpError(400, message, "DESIGN_INVALID");

// ---- fixed option lists ---------------------------------------------------------------------

const FONTS = {
  helvetica: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  georgia: "Georgia, 'Times New Roman', Times, serif",
  impact: "Impact, 'Arial Narrow Bold', 'Arial Black', sans-serif",
};
const FONT_LABELS = { helvetica: "Helvetica / Arial", georgia: "Georgia (serif)", impact: "Impact (bold display)" };
const PADDING = { none: 0, sm: 12, md: 24, lg: 40 };
const ALIGN = ["left", "center", "right"];
const HEADING_SIZE = { sm: 20, md: 26, lg: 32, xl: 40 };
const TEXT_SIZE = { sm: 14, md: 16, lg: 18 };

const DEFAULT_STYLE = Object.freeze({
  font: "helvetica",
  headingFont: "helvetica",
  textColor: "#333333",
  headingColor: "#111111",
  accentColor: "#C62828",
  pageColor: BRAND.page,
  cardColor: "#FFFFFF",
});

const BLOCK_TYPES = [
  "header", "hero", "heading", "paragraph", "product_image", "product_details", "button", "banner", "divider", "footer",
];

const BLOCK_LABELS = {
  header: "Logo and header", hero: "Hero image", heading: "Heading", paragraph: "Paragraph",
  product_image: "Product image", product_details: "Product details", button: "Button (CTA)",
  banner: "Promotional banner", divider: "Divider", footer: "Footer note",
};

// ---- primitive validators -------------------------------------------------------------------

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const HEX = /^#[0-9A-Fa-f]{6}$/;

const text = (value, { max, required = false, multiline = false, label }) => {
  if (value === undefined || value === null || value === "") {
    if (required) throw invalid(`${label} is required.`);
    return "";
  }
  if (typeof value !== "string") throw invalid(`${label} must be text.`);
  let out = value.normalize("NFC").replace(CONTROL, "");
  out = multiline ? out.replace(/\r\n?/g, "\n").trim() : out.replace(/\s+/g, " ").trim();
  if (required && !out) throw invalid(`${label} is required.`);
  if (out.length > max) throw invalid(`${label} must be ${max} characters or fewer.`);
  return out;
};

const color = (value, fallback, label) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !HEX.test(value)) throw invalid(`${label} must be a colour like #C62828.`);
  return value.toUpperCase();
};

const oneOf = (value, list, fallback, label) => {
  if (value === undefined || value === null || value === "") return fallback;
  const keys = Array.isArray(list) ? list : Object.keys(list);
  if (!keys.includes(value)) throw invalid(`${label} has an unsupported value.`);
  return value;
};

// https URL only (no credentials, no spaces, no template placeholders). `allowPath` also accepts
// a site path such as /shop, turned into an absolute https link on the storefront.
const url = (value, { label, required = false, allowPath = false }) => {
  if (value === undefined || value === null || value === "") {
    if (required) throw invalid(`${label} is required.`);
    return "";
  }
  if (typeof value !== "string") throw invalid(`${label} must be a link.`);
  const raw = value.trim();
  if (raw.length > 2048 || /[\s\u0000-\u001F\u007F<>"'`\\{}]/.test(raw)) throw invalid(`${label} is not a valid link.`);
  if (allowPath && raw.startsWith("/") && !raw.startsWith("//")) return `${siteUrl()}${raw}`;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalid(`${label} is not a valid link.`);
  }
  if (parsed.protocol !== "https:") throw invalid(`${label} must start with https://`);
  if (parsed.username || parsed.password) throw invalid(`${label} must not contain a username or password.`);
  return parsed.toString();
};

// ---- block validators (return only known, cleaned fields) -----------------------------------

const common = (b, where) => ({
  padding: oneOf(b.padding, PADDING, "md", `${where} spacing`),
});

const VALIDATORS = {
  header: (b, w) => ({
    ...common(b, w),
    logoUrl: url(b.logoUrl, { label: `${w} logo image` }),
    tagline: text(b.tagline, { max: 80, label: `${w} tagline` }),
    align: oneOf(b.align, ALIGN, "center", `${w} alignment`),
  }),
  hero: (b, w) => ({
    ...common(b, w),
    imageUrl: url(b.imageUrl, { label: `${w} image`, required: true }),
    alt: text(b.alt, { max: 150, label: `${w} image description` }),
    linkUrl: url(b.linkUrl, { label: `${w} link`, allowPath: true }),
  }),
  heading: (b, w) => ({
    ...common(b, w),
    text: text(b.text, { max: 150, required: true, label: `${w} text` }),
    align: oneOf(b.align, ALIGN, "left", `${w} alignment`),
    size: oneOf(b.size, HEADING_SIZE, "lg", `${w} size`),
    color: color(b.color, "", `${w} colour`),
  }),
  paragraph: (b, w) => ({
    ...common(b, w),
    text: text(b.text, { max: 2000, required: true, multiline: true, label: `${w} text` }),
    align: oneOf(b.align, ALIGN, "left", `${w} alignment`),
    size: oneOf(b.size, TEXT_SIZE, "md", `${w} size`),
    color: color(b.color, "", `${w} colour`),
  }),
  product_image: (b, w) => ({
    ...common(b, w),
    imageUrl: url(b.imageUrl, { label: `${w} image`, required: true }),
    alt: text(b.alt, { max: 150, label: `${w} image description` }),
    linkUrl: url(b.linkUrl, { label: `${w} link`, allowPath: true }),
    caption: text(b.caption, { max: 150, label: `${w} caption` }),
  }),
  product_details: (b, w) => {
    const slug = text(b.productSlug, { max: 200, required: true, label: `${w} product` });
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) throw invalid(`${w} product is not valid.`);
    return {
      ...common(b, w),
      productSlug: slug,
      ctaLabel: text(b.ctaLabel, { max: 40, label: `${w} button text` }),
    };
  },
  button: (b, w) => ({
    ...common(b, w),
    label: text(b.label, { max: 40, required: true, label: `${w} label` }),
    url: url(b.url, { label: `${w} link`, required: true, allowPath: true }),
    align: oneOf(b.align, ALIGN, "center", `${w} alignment`),
    bg: color(b.bg, "", `${w} background`),
    color: color(b.color, "", `${w} text colour`),
  }),
  banner: (b, w) => ({
    ...common(b, w),
    text: text(b.text, { max: 120, required: true, label: `${w} text` }),
    subtext: text(b.subtext, { max: 200, label: `${w} sub-text` }),
    bg: color(b.bg, "#111111", `${w} background`),
    color: color(b.color, "#FFFFFF", `${w} text colour`),
    linkUrl: url(b.linkUrl, { label: `${w} link`, allowPath: true }),
  }),
  divider: (b, w) => ({
    ...common(b, w),
    color: color(b.color, "", `${w} colour`),
  }),
  footer: (b, w) => ({
    ...common(b, w),
    text: text(b.text, { max: 500, required: true, multiline: true, label: `${w} text` }),
    align: oneOf(b.align, ALIGN, "center", `${w} alignment`),
  }),
};

const validateStyle = (style) => {
  const s = style && typeof style === "object" && !Array.isArray(style) ? style : {};
  return {
    font: oneOf(s.font, FONTS, DEFAULT_STYLE.font, "Body font"),
    headingFont: oneOf(s.headingFont, FONTS, DEFAULT_STYLE.headingFont, "Heading font"),
    textColor: color(s.textColor, DEFAULT_STYLE.textColor, "Text colour"),
    headingColor: color(s.headingColor, DEFAULT_STYLE.headingColor, "Heading colour"),
    accentColor: color(s.accentColor, DEFAULT_STYLE.accentColor, "Accent colour"),
    pageColor: color(s.pageColor, DEFAULT_STYLE.pageColor, "Background colour"),
    cardColor: color(s.cardColor, DEFAULT_STYLE.cardColor, "Content colour"),
  };
};

// Returns a clean { style, blocks }. Throws a 400 (code DESIGN_INVALID) naming the first problem.
const validateDesign = (input) => {
  const source = input && typeof input === "object" ? input : {};
  if (!Array.isArray(source.blocks)) throw invalid("The email needs a list of content blocks.");
  if (source.blocks.length > MAX_BLOCKS) throw invalid(`An email can have at most ${MAX_BLOCKS} blocks.`);

  const blocks = source.blocks.map((raw, index) => {
    const where = `Block ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid(`${where} is not valid.`);
    if (!BLOCK_TYPES.includes(raw.type)) throw invalid(`${where} has an unknown type.`);
    const id = typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : `b${index + 1}`;
    return { id, type: raw.type, ...VALIDATORS[raw.type](raw, `${BLOCK_LABELS[raw.type]} (${where})`) };
  });

  const design = { style: validateStyle(source.style), blocks };
  if (JSON.stringify(design).length > MAX_DESIGN_JSON) throw invalid("This email is too large. Remove some content.");
  return design;
};

// A neutral starting point. It contains NO offers, prices or product claims: only prompts to write.
const starterDesign = () => ({
  style: { ...DEFAULT_STYLE },
  blocks: [
    { id: "b1", type: "header", padding: "md", logoUrl: "", tagline: "", align: "center" },
    { id: "b2", type: "heading", padding: "md", text: "Write your headline", align: "left", size: "lg", color: "" },
    { id: "b3", type: "paragraph", padding: "md", text: "Write your message here.", align: "left", size: "md", color: "" },
  ],
});

// ---- rendering ------------------------------------------------------------------------------

const postalAddress = () => {
  const base = String(process.env.NEWSLETTER_POSTAL_ADDRESS || "Krishna Bunglow 1, New Ranip, Ahmedabad")
    .replace(CONTROL, "").replace(/\s+/g, " ").trim();
  const pin = String(process.env.NEWSLETTER_POSTAL_PIN || "").trim();
  const complete = /^\d{6}$/.test(pin);
  return { base, pin: complete ? pin : "", complete, line: complete ? `${base}, ${pin}` : base };
};

const px = (key) => PADDING[key] ?? PADDING.md;

const renderBlock = (b, ctx) => {
  const { style } = ctx;
  const font = FONTS[style.font];
  const headingFont = FONTS[style.headingFont];
  const pad = px(b.padding);
  const cell = (inner, extra = "") =>
    `<tr><td class="kv-pad" style="padding:${pad}px 32px;${extra}">${inner}</td></tr>`;
  const link = (href, inner) => (href ? `<a href="${esc(href)}" target="_blank" style="text-decoration:none;color:inherit;">${inner}</a>` : inner);
  const img = (src, alt) =>
    `<img src="${esc(src)}" alt="${esc(alt)}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0;outline:none;text-decoration:none;">`;

  switch (b.type) {
    case "header": {
      const mark = b.logoUrl
        ? `<img src="${esc(b.logoUrl)}" alt="KOVENIK" height="40" style="display:inline-block;height:40px;width:auto;border:0;">`
        : `<span style="font-family:${FONTS.helvetica};font-size:24px;font-weight:800;letter-spacing:8px;color:${style.headingColor};">KOVENIK</span>`;
      const rule = `<div style="width:24px;height:2px;background:${style.accentColor};margin:12px ${b.align === "left" ? "0" : b.align === "right" ? "0 0 auto" : "auto"} 0;font-size:0;line-height:0;">&nbsp;</div>`;
      const tag = b.tagline
        ? `<div style="margin-top:10px;font-family:${font};font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${BRAND.muted};">${esc(b.tagline)}</div>`
        : "";
      return cell(`${link(siteUrl() + "/", mark)}${rule}${tag}`, `text-align:${b.align};border-bottom:1px solid ${BRAND.line};`);
    }
    case "hero":
      return `<tr><td style="padding:${pad}px 0 ${pad}px;">${link(b.linkUrl, img(b.imageUrl, b.alt).replace('width="536"', 'width="600"').replace("max-width:536px", "max-width:600px"))}</td></tr>`;
    case "heading":
      return cell(
        `<h1 class="kv-h1" style="margin:0;font-family:${headingFont};font-size:${HEADING_SIZE[b.size]}px;line-height:${Math.round(HEADING_SIZE[b.size] * 1.2)}px;font-weight:800;color:${b.color || style.headingColor};text-align:${b.align};">${esc(b.text)}</h1>`
      );
    case "paragraph": {
      const html = esc(b.text).replace(/\n{2,}/g, "</p><p style=\"margin:0 0 16px 0;\">").replace(/\n/g, "<br>");
      return cell(
        `<div style="font-family:${font};font-size:${TEXT_SIZE[b.size]}px;line-height:${Math.round(TEXT_SIZE[b.size] * 1.6)}px;color:${b.color || style.textColor};text-align:${b.align};"><p style="margin:0 0 16px 0;">${html}</p></div>`
      );
    }
    case "product_image":
      return cell(
        `${link(b.linkUrl, img(b.imageUrl, b.alt))}` +
          (b.caption ? `<div style="margin-top:8px;font-family:${font};font-size:13px;color:${BRAND.muted};text-align:center;">${esc(b.caption)}</div>` : "")
      );
    case "product_details": {
      const product = ctx.products && ctx.products[b.productSlug];
      if (!product) {
        return cell(
          `<div style="font-family:${font};font-size:14px;color:#B3261E;border:1px dashed #B3261E;padding:12px;">Product “${esc(b.productSlug)}” was not found in the catalogue. It must be fixed before this email can be sent.</div>`
        );
      }
      const productUrl = `${siteUrl()}/product/${encodeURIComponent(product.slug)}`;
      const ctaLabel = b.ctaLabel || "View product";
      return cell(
        (product.image ? `<div style="margin-bottom:14px;">${link(productUrl, img(product.image, product.name))}</div>` : "") +
          `<div style="font-family:${headingFont};font-size:20px;font-weight:800;color:${style.headingColor};">${esc(product.name)}</div>` +
          `<div style="margin-top:6px;font-family:${font};font-size:16px;color:${style.textColor};">${esc(ctx.money(product.price))}</div>` +
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;"><tr><td bgcolor="${style.headingColor}" style="background:${style.headingColor};">` +
          `<a href="${esc(productUrl)}" target="_blank" style="display:inline-block;padding:13px 28px;font-family:${font};font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">${esc(ctaLabel)}</a></td></tr></table>`
      );
    }
    case "button": {
      const bg = b.bg || style.headingColor;
      const fg = b.color || "#FFFFFF";
      const margin = b.align === "left" ? "0" : b.align === "right" ? "0 0 0 auto" : "0 auto";
      return cell(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:${margin};"><tr><td align="center" bgcolor="${bg}" style="background:${bg};">` +
          `<a href="${esc(b.url)}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:${font};font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${fg};text-decoration:none;">${esc(b.label)}</a></td></tr></table>`
      );
    }
    case "banner": {
      const inner =
        `<div style="font-family:${headingFont};font-size:22px;line-height:28px;font-weight:800;color:${b.color};">${esc(b.text)}</div>` +
        (b.subtext ? `<div style="margin-top:6px;font-family:${font};font-size:14px;line-height:22px;color:${b.color};">${esc(b.subtext)}</div>` : "");
      return `<tr><td class="kv-pad" style="padding:${pad}px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${b.bg}" style="background:${b.bg};padding:24px 20px;text-align:center;">${link(b.linkUrl, inner)}</td></tr></table></td></tr>`;
    }
    case "divider":
      return cell(`<div style="height:1px;background:${b.color || BRAND.line};font-size:0;line-height:0;">&nbsp;</div>`);
    case "footer":
      return cell(
        `<div style="font-family:${font};font-size:13px;line-height:20px;color:${BRAND.muted};text-align:${b.align};">${esc(b.text).replace(/\n/g, "<br>")}</div>`
      );
    default:
      return "";
  }
};

const blockText = (b, ctx) => {
  switch (b.type) {
    case "header": return `KOVENIK${b.tagline ? ` - ${b.tagline}` : ""}`;
    case "hero": case "product_image": return [b.alt || (b.type === "hero" ? "" : "Product"), b.caption, b.linkUrl].filter(Boolean).join(" ");
    case "heading": return b.text.toUpperCase();
    case "paragraph": case "footer": return b.text;
    case "product_details": {
      const p = ctx.products && ctx.products[b.productSlug];
      return p ? `${p.name} - ${ctx.money(p.price)}\n${b.ctaLabel || "View product"}: ${siteUrl()}/product/${encodeURIComponent(p.slug)}` : `[Product ${b.productSlug} not found]`;
    }
    case "button": return `${b.label}: ${b.url}`;
    case "banner": return [b.text, b.subtext, b.linkUrl].filter(Boolean).join("\n");
    case "divider": return "----------";
    default: return "";
  }
};

const money = (value) => "₹" + Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// mode: "preview" | "test" | "send"
//   send    -> needs a complete postal address (PIN) or it throws POSTAL_ADDRESS_INCOMPLETE; the unsubscribe
//              link is the UNSUBSCRIBE_PLACEHOLDER, replaced per recipient by the sender.
//   preview -> unsubscribe link is inert; an unset PIN shows as a visible marker.
//   test    -> as preview, and the footer says it is a test.
const renderEmail = (design, { subject = "", preheader = "", products = {}, mode = "preview" } = {}) => {
  const clean = validateDesign(design);
  const address = postalAddress();
  if (mode === "send" && !address.complete) {
    throw httpError(
      409,
      "The postal address in the email footer is incomplete: the PIN code has not been set (NEWSLETTER_POSTAL_PIN). Sending is blocked until it is.",
      "POSTAL_ADDRESS_INCOMPLETE"
    );
  }

  const ctx = { style: clean.style, products, money };
  const unsubUrl = mode === "send" ? UNSUBSCRIBE_PLACEHOLDER : "#";
  // Newsletter mail has no inbox behind it, so readers are pointed to the Contact page instead.
  const contactUrl = `${String(process.env.SITE_URL || process.env.FRONTEND_URL || "https://ardenby.vercel.app").trim().replace(/\/+$/, "")}/contact`;
  const font = FONTS[clean.style.font];
  const year = new Date().getFullYear();

  const addressHtml = address.complete
    ? esc(address.line)
    : `${esc(address.base)}, <span style="background:#FFF3CD;color:#7A4B00;padding:0 4px;">[PIN code not set]</span>`;

  const complianceHtml =
    `<tr><td align="center" bgcolor="${BRAND.panel}" style="background:${BRAND.panel};padding:24px 24px 28px 24px;font-family:${font};font-size:12px;line-height:20px;color:${BRAND.muted};">` +
    `<div style="font-size:14px;font-weight:800;letter-spacing:5px;color:${clean.style.headingColor};margin-bottom:10px;">KOVENIK</div>` +
    `<div style="margin-bottom:10px;">You are receiving this email because you subscribed to the KOVENIK newsletter.</div>` +
    `<div style="margin-bottom:10px;">Please do not reply to this email. Need help? <a href="${esc(contactUrl)}" style="color:${clean.style.headingColor};text-decoration:underline;">Contact us</a>.</div>` +
    `<div style="margin-bottom:10px;"><a href="${esc(unsubUrl)}" style="color:${clean.style.headingColor};text-decoration:underline;font-weight:700;">Unsubscribe</a>` +
    (mode === "test" ? ` <span style="color:#7A4B00;">(test email: in a real send this link unsubscribes the reader)</span>` : "") +
    `</div>` +
    `<div style="margin-bottom:6px;">${addressHtml}</div>` +
    `<div>© ${year} KOVENIK. All rights reserved.</div></td></tr>`;

  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">` +
    `<meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light only">` +
    `<style>@media only screen and (max-width:620px){.kv-pad{padding-left:16px!important;padding-right:16px!important}.kv-h1{font-size:26px!important;line-height:32px!important}}</style>` +
    `<title>${esc(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:${clean.style.pageColor};">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${clean.style.pageColor};">${esc(preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${clean.style.pageColor}" style="background:${clean.style.pageColor};"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${clean.style.cardColor};">` +
    clean.blocks.map((b) => renderBlock(b, ctx)).join("") +
    complianceHtml +
    `</table></td></tr></table></body></html>`;

  const textOut = [
    ...clean.blocks.map((b) => blockText(b, ctx)).filter(Boolean).flatMap((t) => [t, ""]),
    "--",
    "You are receiving this email because you subscribed to the KOVENIK newsletter.",
    `Please do not reply to this email. Need help? Contact us: ${contactUrl}`,
    `Unsubscribe: ${mode === "send" ? UNSUBSCRIBE_PLACEHOLDER : "(link in the real email)"}`,
    address.complete ? address.line : `${address.base}, [PIN code not set]`,
    `© ${year} KOVENIK`,
  ].join("\n");

  return { html, text: textOut, design: clean, address };
};

// The product slugs a design refers to (used to load real catalogue data before rendering).
const productSlugs = (design) => [...new Set((design.blocks || []).filter((b) => b.type === "product_details").map((b) => b.productSlug))];

// Missing products found while rendering (the caller decides whether that blocks a send).
const missingProducts = (design, products) => productSlugs(design).filter((slug) => !(products && products[slug]));

const fillUnsubscribe = (value, unsubscribeUrl) => value.split(UNSUBSCRIBE_PLACEHOLDER).join(unsubscribeUrl);

module.exports = {
  validateDesign,
  validateStyle,
  starterDesign,
  renderEmail,
  postalAddress,
  productSlugs,
  missingProducts,
  fillUnsubscribe,
  UNSUBSCRIBE_PLACEHOLDER,
  DEFAULT_STYLE,
  BLOCK_TYPES,
  BLOCK_LABELS,
  FONTS,
  FONT_LABELS,
  MAX_BLOCKS,
};
