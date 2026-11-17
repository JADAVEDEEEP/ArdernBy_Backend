const { poolPromise } = require("../config/sql");
const audit = require("./audit.service");
const emailDesign = require("./newsletter-email.service");
const newsletter = require("./newsletter.service");

// ==========================================
// NEWSLETTER CAMPAIGNS (management layer)
//
// Drafts, templates, audience, preview, test send, schedule / send / cancel and analytics.
// Delivery itself lives in newsletter-sender.service.js. Recipients are read ONLY through
// newsletter.listSendable / countSendable (status = 'active').
//
// Permissions are enforced by the routes (routes/admin.routes.js); the rules that need data
// (an Admin must not choose recipients) are also enforced here, so a service call can never
// widen what a role may do.
// ==========================================

const STATUSES = ["draft", "scheduled", "sending", "sent", "partially_failed", "failed", "cancelled"];
const AUDIENCE_TYPES = ["all_active", "selected", "source"];
const MAX_SELECTED = 1000;
const MIN_SCHEDULE_LEAD_MS = 60 * 1000;
const MAX_SCHEDULE_AHEAD_MS = 90 * 24 * 3600 * 1000;
const PLACEHOLDERS = ["Write your headline", "Write your message here."];

const httpError = (statusCode, message, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

const isMissingTable = (error) => Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);
const guard = (error) => {
  if (isMissingTable(error)) {
    throw httpError(503, "Newsletter campaigns are not available yet. The database update has not been applied.", "CAMPAIGNS_NOT_AVAILABLE");
  }
  throw error;
};

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const oneLine = (value, max, label, { required = false } = {}) => {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw httpError(400, `${label} must be text.`, "FIELD_INVALID");
  const out = value.normalize("NFC").replace(CONTROL, "").replace(/\s+/g, " ").trim();
  if (required && !out) throw httpError(400, `${label} is required.`, "FIELD_REQUIRED");
  if (out.length > max) throw httpError(400, `${label} must be ${max} characters or fewer.`, "FIELD_INVALID");
  return out;
};

const iso = (column) => `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%sZ')`;
const idOf = (value) => (typeof value === "string" || typeof value === "number") && /^\d{1,18}$/.test(String(value)) ? String(value) : null;
const requireId = (value, what = "Campaign") => {
  const id = idOf(value);
  if (!id) throw httpError(404, `${what} not found.`, "NOT_FOUND");
  return id;
};
const likeTerm = (value) => `%${value.replace(/[|%_]/g, (c) => `|${c}`)}%`;
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};
// UTC "YYYY-MM-DD HH:MM:SS.mmm" for DATETIME(6) parameters.
const sqlDate = (date) => date.toISOString().replace("T", " ").replace("Z", "");

const SELECT_CAMPAIGN = `
  id, name, subject, preheader, status, audience_type, audience_source, audience_ids,
  ${iso("scheduled_at")} AS scheduled_at, ${iso("started_at")} AS started_at,
  ${iso("completed_at")} AS completed_at, ${iso("cancelled_at")} AS cancelled_at,
  total_recipients, error_note, created_by, updated_by, sent_by,
  ${iso("created_at")} AS created_at, ${iso("updated_at")} AS updated_at`;

const campaignDto = (row, { design = null, includeAudienceIds = false } = {}) => ({
  id: String(row.id),
  name: row.name,
  subject: row.subject,
  preheader: row.preheader,
  status: row.status,
  audience: {
    type: row.audience_type,
    source: row.audience_source || null,
    // The chosen subscriber ids are only shown to roles that may choose recipients.
    ...(includeAudienceIds ? { ids: parseJson(row.audience_ids || "[]", []) } : { selectedCount: parseJson(row.audience_ids || "[]", []).length }),
  },
  scheduledAt: row.scheduled_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  cancelledAt: row.cancelled_at,
  totalRecipients: Number(row.total_recipients || 0),
  errorNote: row.error_note || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(design ? { design } : {}),
});

// ---- audience -------------------------------------------------------------------------------

const cleanAudience = (input) => {
  const type = input.audienceType === undefined ? undefined : String(input.audienceType);
  if (type !== undefined && !AUDIENCE_TYPES.includes(type)) {
    throw httpError(400, "Choose all active subscribers, selected subscribers or a signup source.", "AUDIENCE_INVALID");
  }
  const out = {};
  if (type !== undefined) out.type = type;
  if (input.audienceSource !== undefined) {
    const source = input.audienceSource === null ? "" : String(input.audienceSource);
    if (source && !/^[a-z_]{1,24}$/.test(source)) throw httpError(400, "That signup source is not valid.", "AUDIENCE_INVALID");
    out.source = source || null;
  }
  if (input.audienceIds !== undefined) {
    if (!Array.isArray(input.audienceIds)) throw httpError(400, "Selected subscribers must be a list.", "AUDIENCE_INVALID");
    const strict = (x) => (typeof x === "number" ? x : typeof x === "string" && /^d{1,18}$/.test(x) ? Number(x) : NaN);
    const ids = [...new Set(input.audienceIds.map(strict))];
    if (ids.some((x) => !Number.isSafeInteger(x) || x <= 0)) throw httpError(400, "Selected subscribers are not valid.", "AUDIENCE_INVALID");
    if (ids.length > MAX_SELECTED) throw httpError(400, `You can select at most ${MAX_SELECTED} subscribers by hand.`, "AUDIENCE_INVALID");
    out.ids = ids;
  }
  return out;
};

const audienceFilter = (row) => {
  if (row.audience_type === "selected") return { ids: parseJson(row.audience_ids || "[]", []) };
  if (row.audience_type === "source") return { source: row.audience_source || "__none__" };
  return {};
};

// ---- products (real catalogue data only) -----------------------------------------------------

const loadProducts = async (slugs, pool) => {
  if (slugs.length === 0) return {};
  const [rows] = await pool.execute(
    `SELECT p.slug, p.name, p.price,
            (SELECT image_url FROM product_images WHERE product_id = p.id ORDER BY is_primary DESC, sort_order ASC LIMIT 1) AS image
       FROM products p WHERE p.slug IN (${slugs.map(() => "?").join(",")})`,
    slugs
  );
  return Object.fromEntries(rows.map((r) => [r.slug, { slug: r.slug, name: r.name, price: Number(r.price), image: r.image || "" }]));
};

const searchProducts = async (term, deps = {}) => {
  const pool = deps.pool || (await poolPromise);
  const q = typeof term === "string" ? term.normalize("NFC").trim().toLowerCase().slice(0, 80) : "";
  const where = q ? "WHERE LOWER(p.name) LIKE ? ESCAPE '|' OR LOWER(p.slug) LIKE ? ESCAPE '|'" : "";
  const [rows] = await pool.execute(
    `SELECT p.slug, p.name, p.price,
            (SELECT image_url FROM product_images WHERE product_id = p.id ORDER BY is_primary DESC, sort_order ASC LIMIT 1) AS image
       FROM products p ${where} ORDER BY p.name ASC LIMIT 20`,
    q ? [likeTerm(q), likeTerm(q)] : []
  );
  return rows.map((r) => ({ slug: r.slug, name: r.name, price: Number(r.price), image: r.image || "" }));
};

// ---- preview ---------------------------------------------------------------------------------

const preview = async ({ design, subject, preheader }, deps = {}) => {
  const pool = deps.pool || (await poolPromise);
  const clean = emailDesign.validateDesign(design);
  const products = await loadProducts(emailDesign.productSlugs(clean), pool);
  const out = emailDesign.renderEmail(clean, {
    subject: oneLine(subject, 200, "Subject"),
    preheader: oneLine(preheader, 200, "Preview text"),
    products,
    mode: "preview",
  });
  return {
    html: out.html,
    text: out.text,
    warnings: [
      ...emailDesign.missingProducts(clean, products).map((s) => `Product "${s}" was not found in the catalogue.`),
      ...(out.address.complete ? [] : ["The PIN code in the footer address is not set yet. Real sends are blocked until NEWSLETTER_POSTAL_PIN is configured."]),
    ],
  };
};

// ---- campaigns: create / read / list / update / duplicate ------------------------------------

const create = async ({ name, subject, preheader, design, templateId, ...audienceInput }, actor, deps = {}) => {
  const pool = deps.pool || (await poolPromise);
  if (actor.role !== "superadmin" && (audienceInput.audienceType !== undefined || audienceInput.audienceIds !== undefined || audienceInput.audienceSource !== undefined)) {
    throw httpError(403, "Only a Super Admin can choose recipients.", "SUPERADMIN_REQUIRED");
  }

  try {
    let base = design;
    let templateSubject = "";
    let templatePre = "";
    if (templateId !== undefined && templateId !== null && templateId !== "") {
      const [rows] = await pool.execute("SELECT subject, preheader, blocks_json, style_json FROM newsletter_templates WHERE id = ? LIMIT 1", [requireId(templateId, "Template")]);
      if (!rows[0]) throw httpError(404, "Template not found.", "NOT_FOUND");
      base = { blocks: parseJson(rows[0].blocks_json, []), style: parseJson(rows[0].style_json, {}) };
      templateSubject = rows[0].subject || "";
      templatePre = rows[0].preheader || "";
    }
    const clean = emailDesign.validateDesign(base || emailDesign.starterDesign());
    const aud = cleanAudience(audienceInput);

    const cleanName = oneLine(name, 120, "Campaign name", { required: true });
    const [result] = await pool.execute(
      `INSERT INTO newsletter_campaigns
         (name, subject, preheader, blocks_json, style_json, status, audience_type, audience_source, audience_ids,
          created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [
        cleanName,
        oneLine(subject === undefined ? templateSubject : subject, 200, "Subject"),
        oneLine(preheader === undefined ? templatePre : preheader, 200, "Preview text"),
        JSON.stringify(clean.blocks),
        JSON.stringify(clean.style),
        aud.type || "all_active",
        aud.source || null,
        aud.ids ? JSON.stringify(aud.ids) : null,
        actor.id || null,
        actor.id || null,
      ]
    );
    const id = String(result.insertId);
    await audit.record({ actor, action: "newsletter.campaign.create", resourceType: "newsletter_campaign", resourceId: id, after: { status: "draft", fromTemplate: Boolean(templateId) } });
    return get(id, actor, { pool });
  } catch (error) {
    return guard(error);
  }
};

const get = async (idInput, actor, deps = {}) => {
  const id = requireId(idInput);
  try {
    const pool = deps.pool || (await poolPromise);
    const [rows] = await pool.execute(`SELECT ${SELECT_CAMPAIGN}, blocks_json, style_json FROM newsletter_campaigns WHERE id = ? LIMIT 1`, [id]);
    if (!rows[0]) throw httpError(404, "Campaign not found.", "NOT_FOUND");
    const row = rows[0];
    const stats = (await statsFor([id], pool))[id];
    return {
      ...campaignDto(row, {
        design: { blocks: parseJson(row.blocks_json, []), style: parseJson(row.style_json, {}) },
        includeAudienceIds: actor?.role === "superadmin",
      }),
      stats,
    };
  } catch (error) {
    return guard(error);
  }
};

const list = async ({ page, limit, status, search } = {}, deps = {}) => {
  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 50);
  const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
  const where = [];
  const params = [];
  const wanted = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (wanted) {
    if (!STATUSES.includes(wanted)) throw httpError(400, "Unknown status filter.", "STATUS_INVALID");
    where.push("status = ?");
    params.push(wanted);
  }
  const term = typeof search === "string" ? search.normalize("NFC").trim().toLowerCase().slice(0, 100) : "";
  if (term) {
    where.push("(LOWER(name) LIKE ? ESCAPE '|' OR LOWER(subject) LIKE ? ESCAPE '|')");
    params.push(likeTerm(term), likeTerm(term));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const pool = deps.pool || (await poolPromise);
    const [[count]] = await pool.execute(`SELECT COUNT(*) AS c FROM newsletter_campaigns ${clause}`, params);
    const total = Number(count.c);
    const [rows] = await pool.execute(
      `SELECT ${SELECT_CAMPAIGN} FROM newsletter_campaigns ${clause}
        ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(pageNumber - 1) * pageSize}`,
      params
    );
    const stats = await statsFor(rows.map((r) => String(r.id)), pool);
    return {
      campaigns: rows.map((r) => ({ ...campaignDto(r), stats: stats[String(r.id)] })),
      pagination: { page: pageNumber, limit: pageSize, total, totalPages: Math.max(Math.ceil(total / pageSize), 1) },
    };
  } catch (error) {
    return guard(error);
  }
};

const update = async (idInput, patch, actor, deps = {}) => {
  const id = requireId(idInput);
  const input = patch && typeof patch === "object" ? patch : {};
  const touchesAudience = ["audienceType", "audienceSource", "audienceIds"].some((k) => input[k] !== undefined);
  if (touchesAudience && actor.role !== "superadmin") {
    throw httpError(403, "Only a Super Admin can choose recipients.", "SUPERADMIN_REQUIRED");
  }

  try {
    const pool = deps.pool || (await poolPromise);
    const [rows] = await pool.execute("SELECT status, audience_type FROM newsletter_campaigns WHERE id = ? LIMIT 1", [id]);
    if (!rows[0]) throw httpError(404, "Campaign not found.", "NOT_FOUND");
    if (rows[0].status !== "draft") {
      throw httpError(409, "Only a draft can be edited. Duplicate this campaign to make changes.", "NOT_DRAFT");
    }

    const sets = [];
    const params = [];
    if (input.name !== undefined) { sets.push("name = ?"); params.push(oneLine(input.name, 120, "Campaign name", { required: true })); }
    if (input.subject !== undefined) { sets.push("subject = ?"); params.push(oneLine(input.subject, 200, "Subject")); }
    if (input.preheader !== undefined) { sets.push("preheader = ?"); params.push(oneLine(input.preheader, 200, "Preview text")); }
    if (input.design !== undefined) {
      const clean = emailDesign.validateDesign(input.design);
      sets.push("blocks_json = ?", "style_json = ?");
      params.push(JSON.stringify(clean.blocks), JSON.stringify(clean.style));
    }
    if (touchesAudience) {
      const aud = cleanAudience(input);
      if (aud.type !== undefined) { sets.push("audience_type = ?"); params.push(aud.type); }
      if (aud.source !== undefined) { sets.push("audience_source = ?"); params.push(aud.source); }
      if (aud.ids !== undefined) { sets.push("audience_ids = ?"); params.push(JSON.stringify(aud.ids)); }
    }
    if (sets.length === 0) return get(id, actor, { pool });

    const [result] = await pool.execute(
      `UPDATE newsletter_campaigns SET ${sets.join(", ")}, updated_by = ?, updated_at = UTC_TIMESTAMP(6)
        WHERE id = ? AND status = 'draft'`,
      [...params, actor.id || null, id]
    );
    if (result.affectedRows !== 1) throw httpError(409, "Only a draft can be edited.", "NOT_DRAFT");
    await audit.record({
      actor, action: "newsletter.campaign.update", resourceType: "newsletter_campaign", resourceId: id,
      after: { fields: Object.keys(input).filter((k) => input[k] !== undefined) },
    });
    return get(id, actor, { pool });
  } catch (error) {
    return guard(error);
  }
};

const duplicate = async (idInput, actor, deps = {}) => {
  const id = requireId(idInput);
  try {
    const pool = deps.pool || (await poolPromise);
    const [rows] = await pool.execute("SELECT name, subject, preheader, blocks_json, style_json FROM newsletter_campaigns WHERE id = ? LIMIT 1", [id]);
    if (!rows[0]) throw httpError(404, "Campaign not found.", "NOT_FOUND");
    const r = rows[0];
    // The copy is a fresh DRAFT: no schedule, no results, and the audience is reset to the default.
    const [result] = await pool.execute(
      `INSERT INTO newsletter_campaigns
         (name, subject, preheader, blocks_json, style_json, status, audience_type, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', 'all_active', ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [`Copy of ${r.name}`.slice(0, 120), r.subject, r.preheader, r.blocks_json, r.style_json, actor.id || null, actor.id || null]
    );
    const newId = String(result.insertId);
    await audit.record({ actor, action: "newsletter.campaign.duplicate", resourceType: "newsletter_campaign", resourceId: newId, after: { copiedFrom: id } });
    return get(newId, actor, { pool });
  } catch (error) {
    return guard(error);
  }
};

// ---- readiness checks shared by test / schedule / send ---------------------------------------

const contentBlocks = new Set(["hero", "heading", "paragraph", "product_image", "product_details", "button", "banner"]);

const loadForSending = async (id, pool) => {
  const [rows] = await pool.execute(
    `SELECT ${SELECT_CAMPAIGN}, blocks_json, style_json FROM newsletter_campaigns WHERE id = ? LIMIT 1`, [id]
  );
  if (!rows[0]) throw httpError(404, "Campaign not found.", "NOT_FOUND");
  return rows[0];
};

// Throws a precise 4xx when the campaign is not fit to leave the building. Used by test, schedule and send.
const assertReady = async (row, pool, { mode }) => {
  if (!row.subject || !String(row.subject).trim()) throw httpError(400, "Add an email subject first.", "SUBJECT_REQUIRED");
  const design = emailDesign.validateDesign({ blocks: parseJson(row.blocks_json, []), style: parseJson(row.style_json, {}) });
  if (!design.blocks.some((b) => contentBlocks.has(b.type))) {
    throw httpError(400, "The email has no content yet. Add a heading, paragraph, image or button.", "NO_CONTENT");
  }
  const leftover = design.blocks.find((b) => (b.type === "heading" || b.type === "paragraph") && PLACEHOLDERS.includes(b.text));
  if (leftover) throw httpError(400, `Replace the placeholder text “${leftover.text}” before sending.`, "PLACEHOLDER_TEXT");
  const products = await loadProducts(emailDesign.productSlugs(design), pool);
  const missing = emailDesign.missingProducts(design, products);
  if (missing.length) throw httpError(409, `Product "${missing[0]}" was not found in the catalogue.`, "PRODUCT_MISSING");
  // Rendering in "send" mode also proves the compliance footer can be built (postal address complete).
  emailDesign.renderEmail(design, { subject: row.subject, preheader: row.preheader, products, mode });
  return { design, products };
};

// ---- test send (Super Admin) -----------------------------------------------------------------

const defaultSendMail = (mail) => require("../config/mailer").transporter.sendMail(mail);
const defaultSender = () => require("../config/mailer").getBrevoSender();

const sendTest = async (idInput, { to } = {}, actor, deps = {}) => {
  const id = requireId(idInput);
  try {
    const pool = deps.pool || (await poolPromise);
    const row = await loadForSending(id, pool);
    const { design, products } = await assertReady(row, pool, { mode: "test" });

    // A test goes to the Super Admin's own address, or to other ADMIN accounts. It can never be used
    // to mail an arbitrary outside address through our sender.
    let wanted = Array.isArray(to) && to.length ? to : [actor.email];
    wanted = [...new Set(wanted.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))];
    if (wanted.length === 0 || wanted.length > 3) throw httpError(400, "Send a test to between one and three admin addresses.", "TEST_RECIPIENTS_INVALID");
    const [accounts] = await pool.execute(
      `SELECT LOWER(email) AS email FROM profiles WHERE LOWER(email) IN (${wanted.map(() => "?").join(",")}) AND role IN ('admin','superadmin') AND is_active = 1`,
      wanted
    );
    const allowed = new Set(accounts.map((a) => a.email));
    const rejected = wanted.filter((e) => !allowed.has(e));
    if (rejected.length) throw httpError(400, "Test emails can only be sent to active Admin or Super Admin accounts.", "TEST_RECIPIENTS_INVALID");

    const out = emailDesign.renderEmail(design, { subject: row.subject, preheader: row.preheader, products, mode: "test" });
    const sender = (deps.sender || defaultSender)();
    const sendMail = deps.sendMail || defaultSendMail;
    for (const address of wanted) {
      try {
        await sendMail({
          from: sender.from,
          envelope: { from: sender.envelopeFrom, to: address },
          to: address,
          subject: `[TEST] ${row.subject}`,
          text: out.text,
          html: out.html,
        });
      } catch (error) {
        console.error("Newsletter test email failed:", error.code || error.responseCode || "error");
        throw httpError(502, "The test email could not be sent. Check the email settings and try again.", "TEST_SEND_FAILED");
      }
    }
    await audit.record({ actor, action: "newsletter.campaign.test_send", resourceType: "newsletter_campaign", resourceId: id, after: { recipients: wanted.length } });
    return { sent: wanted.length };
  } catch (error) {
    return guard(error);
  }
};

// ---- schedule / send / cancel (Super Admin) --------------------------------------------------

const confirmCount = async (row, { confirm, expectedRecipients }, deps) => {
  if (confirm !== true) throw httpError(400, "Please confirm that you want to send this campaign.", "CONFIRM_REQUIRED");
  const current = await newsletter.countSendable(audienceFilter(row), deps);
  if (current === 0) throw httpError(409, "There are no active subscribers in this audience.", "NO_RECIPIENTS");
  if (!Number.isInteger(expectedRecipients) || expectedRecipients !== current) {
    const error = httpError(409, `The audience has changed: it now has ${current} active subscriber(s). Please review and confirm again.`, "AUDIENCE_CHANGED");
    error.currentRecipients = current;
    throw error;
  }
  return current;
};

const schedule = async (idInput, { scheduledAt, confirm, expectedRecipients } = {}, actor, deps = {}) => {
  const id = requireId(idInput);
  const when = typeof scheduledAt === "string" ? new Date(scheduledAt) : null;
  if (!when || Number.isNaN(when.getTime())) throw httpError(400, "Choose a valid date and time.", "SCHEDULE_INVALID");
  const now = (deps.now || Date.now)();
  if (when.getTime() < now + MIN_SCHEDULE_LEAD_MS) throw httpError(400, "Schedule at least one minute in the future.", "SCHEDULE_INVALID");
  if (when.getTime() > now + MAX_SCHEDULE_AHEAD_MS) throw httpError(400, "You can schedule at most 90 days ahead.", "SCHEDULE_INVALID");

  try {
    const pool = deps.pool || (await poolPromise);
    const row = await loadForSending(id, pool);
    if (!["draft", "scheduled"].includes(row.status)) throw httpError(409, "Only a draft can be scheduled.", "NOT_DRAFT");
    await assertReady(row, pool, { mode: "send" });
    const recipients = await confirmCount(row, { confirm, expectedRecipients }, { pool });

    const [result] = await pool.execute(
      `UPDATE newsletter_campaigns
          SET status = 'scheduled', scheduled_at = ?, sent_by = ?, updated_by = ?, updated_at = UTC_TIMESTAMP(6), error_note = NULL
        WHERE id = ? AND status IN ('draft', 'scheduled')`,
      [sqlDate(when), actor.id || null, actor.id || null, id]
    );
    if (result.affectedRows !== 1) throw httpError(409, "Only a draft can be scheduled.", "NOT_DRAFT");
    await audit.record({
      actor, action: "newsletter.campaign.schedule", resourceType: "newsletter_campaign", resourceId: id,
      before: { status: row.status }, after: { status: "scheduled", scheduledAt: when.toISOString(), recipients, audience: row.audience_type },
    });
    return get(id, actor, { pool });
  } catch (error) {
    return guard(error);
  }
};

const send = async (idInput, { confirm, expectedRecipients } = {}, actor, deps = {}) => {
  const id = requireId(idInput);
  try {
    const pool = deps.pool || (await poolPromise);
    const row = await loadForSending(id, pool);
    if (!["draft", "scheduled"].includes(row.status)) throw httpError(409, "Only a draft or scheduled campaign can be sent.", "NOT_DRAFT");
    await assertReady(row, pool, { mode: "send" });
    const recipients = await confirmCount(row, { confirm, expectedRecipients }, { pool });

    // "Send now" uses the same durable path as a scheduled send: mark it due, the sender picks it up.
    const [result] = await pool.execute(
      `UPDATE newsletter_campaigns
          SET status = 'scheduled', scheduled_at = UTC_TIMESTAMP(6), sent_by = ?, updated_by = ?, updated_at = UTC_TIMESTAMP(6), error_note = NULL
        WHERE id = ? AND status IN ('draft', 'scheduled')`,
      [actor.id || null, actor.id || null, id]
    );
    if (result.affectedRows !== 1) throw httpError(409, "This campaign can no longer be sent.", "NOT_DRAFT");
    await audit.record({
      actor, action: "newsletter.campaign.send", resourceType: "newsletter_campaign", resourceId: id,
      before: { status: row.status }, after: { status: "sending", recipients, audience: row.audience_type },
    });
    // Start right away without making the admin wait; the periodic tick and the worker endpoint continue it.
    if (deps.kick !== false) {
      try { require("./newsletter-sender.service").kick(); } catch { /* the tick will pick it up */ }
    }
    return get(id, actor, { pool });
  } catch (error) {
    return guard(error);
  }
};

const cancel = async (idInput, actor, deps = {}) => {
  const id = requireId(idInput);
  try {
    const pool = deps.pool || (await poolPromise);
    const [rows] = await pool.execute("SELECT status FROM newsletter_campaigns WHERE id = ? LIMIT 1", [id]);
    if (!rows[0]) throw httpError(404, "Campaign not found.", "NOT_FOUND");
    const [result] = await pool.execute(
      `UPDATE newsletter_campaigns
          SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(6), locked_until = NULL, updated_by = ?, updated_at = UTC_TIMESTAMP(6)
        WHERE id = ? AND status IN ('scheduled', 'sending')`,
      [actor.id || null, id]
    );
    if (result.affectedRows !== 1) throw httpError(409, "Only a scheduled or sending campaign can be cancelled.", "NOT_CANCELLABLE");
    // Nothing still waiting in the queue will go out. Emails already handed to the mail server cannot be recalled.
    const [skipped] = await pool.execute(
      `UPDATE newsletter_campaign_recipients
          SET status = 'skipped', error_kind = 'cancelled', last_error = 'Campaign cancelled', updated_at = UTC_TIMESTAMP(6)
        WHERE campaign_id = ? AND status = 'queued'`,
      [id]
    );
    await audit.record({
      actor, action: "newsletter.campaign.cancel", resourceType: "newsletter_campaign", resourceId: id,
      before: { status: rows[0].status }, after: { status: "cancelled", skippedRecipients: skipped.affectedRows },
    });
    return get(id, actor, { pool });
  } catch (error) {
    return guard(error);
  }
};

const audienceCount = async (idInput, deps = {}) => {
  const id = requireId(idInput);
  try {
    const pool = deps.pool || (await poolPromise);
    const [rows] = await pool.execute("SELECT audience_type, audience_source, audience_ids FROM newsletter_campaigns WHERE id = ? LIMIT 1", [id]);
    if (!rows[0]) throw httpError(404, "Campaign not found.", "NOT_FOUND");
    return { recipients: await newsletter.countSendable(audienceFilter(rows[0]), { pool }) };
  } catch (error) {
    return guard(error);
  }
};

const signupSources = async (deps = {}) => {
  try {
    const pool = deps.pool || (await poolPromise);
    const [rows] = await pool.execute("SELECT source, COUNT(*) AS c FROM newsletter_subscribers WHERE status = 'active' GROUP BY source ORDER BY source");
    return rows.map((r) => ({ source: r.source, active: Number(r.c) }));
  } catch (error) {
    return guard(error);
  }
};

// ---- templates -------------------------------------------------------------------------------

const templateDto = (r, withDesign = false) => ({
  id: String(r.id),
  name: r.name,
  subject: r.subject || "",
  preheader: r.preheader || "",
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(withDesign ? { design: { blocks: parseJson(r.blocks_json, []), style: parseJson(r.style_json, {}) } } : {}),
});

const listTemplates = async (deps = {}) => {
  try {
    const pool = deps.pool || (await poolPromise);
    const [rows] = await pool.execute(
      `SELECT id, name, subject, preheader, ${iso("created_at")} AS created_at, ${iso("updated_at")} AS updated_at
         FROM newsletter_templates ORDER BY name ASC LIMIT 200`
    );
    return rows.map((r) => templateDto(r));
  } catch (error) {
    return guard(error);
  }
};

const getTemplate = async (idInput, deps = {}) => {
  const id = requireId(idInput, "Template");
  try {
    const pool = deps.pool || (await poolPromise);
    const [rows] = await pool.execute(
      `SELECT id, name, subject, preheader, blocks_json, style_json, ${iso("created_at")} AS created_at, ${iso("updated_at")} AS updated_at
         FROM newsletter_templates WHERE id = ? LIMIT 1`, [id]
    );
    if (!rows[0]) throw httpError(404, "Template not found.", "NOT_FOUND");
    return templateDto(rows[0], true);
  } catch (error) {
    return guard(error);
  }
};

const saveTemplate = async (idInput, { name, subject, preheader, design }, actor, deps = {}) => {
  const creating = idInput === undefined || idInput === null;
  const id = creating ? null : requireId(idInput, "Template");
  const cleanName = oneLine(name, 120, "Template name", { required: true });
  const clean = emailDesign.validateDesign(design);
  try {
    const pool = deps.pool || (await poolPromise);
    let savedId = id;
    try {
      if (creating) {
        const [result] = await pool.execute(
          `INSERT INTO newsletter_templates (name, subject, preheader, blocks_json, style_json, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [cleanName, oneLine(subject, 200, "Subject") || null, oneLine(preheader, 200, "Preview text") || null, JSON.stringify(clean.blocks), JSON.stringify(clean.style), actor.id || null, actor.id || null]
        );
        savedId = String(result.insertId);
      } else {
        const [result] = await pool.execute(
          `UPDATE newsletter_templates SET name = ?, subject = ?, preheader = ?, blocks_json = ?, style_json = ?, updated_by = ?, updated_at = UTC_TIMESTAMP(6)
            WHERE id = ?`,
          [cleanName, oneLine(subject, 200, "Subject") || null, oneLine(preheader, 200, "Preview text") || null, JSON.stringify(clean.blocks), JSON.stringify(clean.style), actor.id || null, id]
        );
        if (result.affectedRows !== 1) throw httpError(404, "Template not found.", "NOT_FOUND");
      }
    } catch (error) {
      if (error && error.code === "ER_DUP_ENTRY") throw httpError(409, "A template with that name already exists.", "TEMPLATE_NAME_TAKEN");
      throw error;
    }
    await audit.record({ actor, action: creating ? "newsletter.template.create" : "newsletter.template.update", resourceType: "newsletter_template", resourceId: savedId });
    return getTemplate(savedId, { pool });
  } catch (error) {
    return guard(error);
  }
};

const deleteTemplate = async (idInput, actor, deps = {}) => {
  const id = requireId(idInput, "Template");
  try {
    const pool = deps.pool || (await poolPromise);
    const [result] = await pool.execute("DELETE FROM newsletter_templates WHERE id = ?", [id]);
    if (result.affectedRows !== 1) throw httpError(404, "Template not found.", "NOT_FOUND");
    await audit.record({ actor, action: "newsletter.template.delete", resourceType: "newsletter_template", resourceId: id });
    return { deleted: true };
  } catch (error) {
    return guard(error);
  }
};

// ---- analytics -------------------------------------------------------------------------------
//
// Only facts we really have:
//   queued / sent / failed / skipped  - our own delivery records ("sent" = accepted by the mail server)
//   delivered / bounced / complaints  - ONLY from provider webhooks; null (not 0) when none arrived
//   unsubscribed                      - recipients who used the unsubscribe link in THIS campaign's email
// No opens, no clicks: SMTP gives no reliable tracking, so none is shown.

const statsFor = async (ids, pool) => {
  const out = {};
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(",");

  const [counts] = await pool.execute(
    `SELECT campaign_id,
            COUNT(*) AS queued,
            SUM(status IN ('queued','sending')) AS pending,
            SUM(sent_at IS NOT NULL) AS sent,
            SUM(status = 'failed') AS failed,
            SUM(status = 'skipped') AS skipped,
            SUM(delivered_at IS NOT NULL) AS delivered,
            SUM(bounced_at IS NOT NULL) AS bounced
       FROM newsletter_campaign_recipients WHERE campaign_id IN (${marks}) GROUP BY campaign_id`,
    ids
  );
  const [unsubs] = await pool.execute(
    `SELECT r.campaign_id, COUNT(*) AS c
       FROM newsletter_campaign_recipients r
       JOIN newsletter_tokens t ON t.token_hash = r.unsub_token_hash AND t.purpose = 'unsubscribe' AND t.used_at IS NOT NULL
      WHERE r.campaign_id IN (${marks}) GROUP BY r.campaign_id`,
    ids
  );
  const [events] = await pool.execute(
    `SELECT campaign_id, COUNT(*) AS c, SUM(event = 'complaint') AS complaints
       FROM newsletter_events WHERE campaign_id IN (${marks}) GROUP BY campaign_id`,
    ids
  );
  const [times] = await pool.execute(
    `SELECT id, TIMESTAMPDIFF(SECOND, started_at, completed_at) AS seconds FROM newsletter_campaigns WHERE id IN (${marks})`,
    ids
  );

  const byId = (rows, key = "campaign_id") => Object.fromEntries(rows.map((r) => [String(r[key]), r]));
  const c = byId(counts), u = byId(unsubs), e = byId(events), t = byId(times, "id");

  for (const id of ids) {
    const row = c[id] || {};
    const sent = Number(row.sent || 0);
    const failed = Number(row.failed || 0);
    const providerData = Number((e[id] || {}).c || 0) > 0;
    const unsubscribed = Number((u[id] || {}).c || 0);
    out[id] = {
      queued: Number(row.queued || 0),
      pending: Number(row.pending || 0),
      sent,
      failed,
      skipped: Number(row.skipped || 0),
      delivered: providerData ? Number(row.delivered || 0) : null,
      bounced: providerData ? Number(row.bounced || 0) : null,
      complaints: providerData ? Number((e[id] || {}).complaints || 0) : null,
      unsubscribed,
      providerData,
      acceptanceRate: pct(sent, sent + failed),
      deliveryRate: providerData ? pct(Number(row.delivered || 0), sent) : null,
      bounceRate: providerData ? pct(Number(row.bounced || 0), sent) : null,
      unsubscribeRate: pct(unsubscribed, sent),
      completionSeconds: t[id] && t[id].seconds !== null && t[id].seconds !== undefined ? Number(t[id].seconds) : null,
    };
  }
  return out;
};

const overview = async (deps = {}) => {
  try {
    const pool = deps.pool || (await poolPromise);
    const [[subs]] = await pool.execute("SELECT COUNT(*) AS total, SUM(status = 'active') AS active FROM newsletter_subscribers");
    const [byStatus] = await pool.execute("SELECT status, COUNT(*) AS c FROM newsletter_campaigns GROUP BY status");
    const counts = Object.fromEntries(byStatus.map((r) => [r.status, Number(r.c)]));
    const totalCampaigns = Object.values(counts).reduce((a, b) => a + b, 0);

    const [[agg]] = await pool.execute(
      `SELECT COUNT(*) AS queued, SUM(sent_at IS NOT NULL) AS sent, SUM(status = 'failed') AS failed,
              SUM(delivered_at IS NOT NULL) AS delivered, SUM(bounced_at IS NOT NULL) AS bounced
         FROM newsletter_campaign_recipients`
    );
    const [[ev]] = await pool.execute("SELECT COUNT(*) AS c FROM newsletter_events");
    const [[un]] = await pool.execute(
      `SELECT COUNT(*) AS c FROM newsletter_campaign_recipients r
         JOIN newsletter_tokens t ON t.token_hash = r.unsub_token_hash AND t.purpose = 'unsubscribe' AND t.used_at IS NOT NULL`
    );

    const [recent] = await pool.execute(`SELECT ${SELECT_CAMPAIGN} FROM newsletter_campaigns ORDER BY id DESC LIMIT 8`);
    const stats = await statsFor(recent.map((r) => String(r.id)), pool);
    const recentCampaigns = recent.map((r) => ({ ...campaignDto(r), stats: stats[String(r.id)] }));

    // Chart: the last 10 campaigns that actually started, oldest first.
    const [done] = await pool.execute(
      `SELECT id, name FROM newsletter_campaigns WHERE started_at IS NOT NULL ORDER BY id DESC LIMIT 10`
    );
    const doneStats = await statsFor(done.map((r) => String(r.id)), pool);
    const performance = done.reverse().map((r) => ({
      id: String(r.id), name: r.name,
      sent: doneStats[String(r.id)].sent, failed: doneStats[String(r.id)].failed,
      bounced: doneStats[String(r.id)].bounced, unsubscribed: doneStats[String(r.id)].unsubscribed,
    }));

    const sent = Number(agg.sent || 0);
    const providerData = Number(ev.c) > 0;
    return {
      subscribers: { total: Number(subs.total || 0), active: Number(subs.active || 0) },
      campaigns: {
        total: totalCampaigns,
        draft: counts.draft || 0,
        scheduled: counts.scheduled || 0,
        sending: counts.sending || 0,
        sent: (counts.sent || 0) + (counts.partially_failed || 0),
        failed: counts.failed || 0,
        cancelled: counts.cancelled || 0,
      },
      emails: {
        queued: Number(agg.queued || 0), sent, failed: Number(agg.failed || 0),
        delivered: providerData ? Number(agg.delivered || 0) : null,
        bounced: providerData ? Number(agg.bounced || 0) : null,
        unsubscribed: Number(un.c || 0),
      },
      rates: {
        acceptance: pct(sent, sent + Number(agg.failed || 0)),
        delivery: providerData ? pct(Number(agg.delivered || 0), sent) : null,
        bounce: providerData ? pct(Number(agg.bounced || 0), sent) : null,
        unsubscribe: pct(Number(un.c || 0), sent),
      },
      providerData,
      performance,
      recent: recentCampaigns,
    };
  } catch (error) {
    return guard(error);
  }
};

// Per-recipient delivery records, with e-mail addresses: Super Admin only (enforced by the route).
const recipientReport = async (idInput, { page, limit, status } = {}, deps = {}) => {
  const id = requireId(idInput);
  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
  const where = ["r.campaign_id = ?"];
  const params = [id];
  const wanted = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (wanted) {
    if (!["queued", "sending", "sent", "failed", "skipped"].includes(wanted)) throw httpError(400, "Unknown status filter.", "STATUS_INVALID");
    where.push("r.status = ?");
    params.push(wanted);
  }
  try {
    const pool = deps.pool || (await poolPromise);
    const [[count]] = await pool.execute(`SELECT COUNT(*) AS c FROM newsletter_campaign_recipients r WHERE ${where.join(" AND ")}`, params);
    const [rows] = await pool.execute(
      `SELECT r.id, s.email, r.status, r.attempts, r.error_kind, r.last_error,
              ${iso("r.sent_at")} AS sent_at, ${iso("r.delivered_at")} AS delivered_at, ${iso("r.bounced_at")} AS bounced_at
         FROM newsletter_campaign_recipients r JOIN newsletter_subscribers s ON s.id = r.subscriber_id
        WHERE ${where.join(" AND ")} ORDER BY r.id ASC LIMIT ${pageSize} OFFSET ${(pageNumber - 1) * pageSize}`,
      params
    );
    const total = Number(count.c);
    return {
      recipients: rows.map((r) => ({
        id: String(r.id), email: r.email, status: r.status, attempts: Number(r.attempts),
        errorKind: r.error_kind, error: r.last_error, sentAt: r.sent_at, deliveredAt: r.delivered_at, bouncedAt: r.bounced_at,
      })),
      pagination: { page: pageNumber, limit: pageSize, total, totalPages: Math.max(Math.ceil(total / pageSize), 1) },
    };
  } catch (error) {
    return guard(error);
  }
};

const { csvLine, startCsv, write } = require("./export.service");

const streamReportCsv = async ({ res, id: idInput, actor }, deps = {}) => {
  const id = requireId(idInput);
  const pool = deps.pool || (await poolPromise);
  let written = 0;
  let started = false;
  let failure = null;
  try {
    const [probe] = await pool.execute("SELECT id FROM newsletter_campaigns WHERE id = ? LIMIT 1", [id]);
    if (!probe[0]) throw httpError(404, "Campaign not found.", "NOT_FOUND");
    await startCsv(res, `kovenik-campaign-${id}-report.csv`);
    started = true;
    await write(res, csvLine(["email", "status", "attempts", "sent_at_utc", "delivered_at_utc", "bounced_at_utc", "error"]));
    let after = 0;
    for (;;) {
      const [rows] = await pool.execute(
        `SELECT r.id, s.email, r.status, r.attempts, r.last_error,
                ${iso("r.sent_at")} AS sent_at, ${iso("r.delivered_at")} AS delivered_at, ${iso("r.bounced_at")} AS bounced_at
           FROM newsletter_campaign_recipients r JOIN newsletter_subscribers s ON s.id = r.subscriber_id
          WHERE r.campaign_id = ? AND r.id > ? ORDER BY r.id ASC LIMIT 500`,
        [id, after]
      );
      if (rows.length === 0) break;
      let chunk = "";
      for (const r of rows) chunk += csvLine([r.email, r.status, Number(r.attempts), r.sent_at, r.delivered_at, r.bounced_at, r.last_error]);
      await write(res, chunk);
      written += rows.length;
      after = rows[rows.length - 1].id;
      if (rows.length < 500) break;
    }
    res.end();
  } catch (error) {
    failure = error;
    if (!started) return guard(error);
    res.destroy();
  } finally {
    if (started || failure) {
      await audit.record({
        actor, action: "export.newsletter_campaign", resourceType: "export", resourceId: id,
        outcome: failure ? "failure" : "success", reason: failure ? String(failure.message).slice(0, 200) : null, after: { rows: written },
      });
    }
  }
};

module.exports = {
  STATUSES,
  create, get, list, update, duplicate,
  preview, searchProducts, loadProducts,
  sendTest, schedule, send, cancel, audienceCount, signupSources,
  listTemplates, getTemplate, saveTemplate, deleteTemplate,
  overview, statsFor, recipientReport, streamReportCsv,
  audienceFilter, assertReady, loadForSending,
};
