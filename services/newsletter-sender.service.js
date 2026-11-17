const crypto = require("crypto");
const { poolPromise } = require("../config/sql");
const campaigns = require("./newsletter-campaign.service");
const emailDesign = require("./newsletter-email.service");
const newsletter = require("./newsletter.service");

// ==========================================
// NEWSLETTER SENDING ENGINE
//
// Everything that matters lives in MySQL, so a restart loses nothing:
//   * a campaign that is "scheduled" stays scheduled until its time passes, whoever notices first;
//   * every recipient is a row (newsletter_campaign_recipients) that doubles as the queue and the delivery record;
//   * a short lease on the campaign (locked_by / locked_until) means two ticks or two servers never process
//     the same campaign at once;
//   * each recipient is CLAIMED with one atomic UPDATE before anything is sent. The claim also re-checks that the
//     subscriber is still `active` and the campaign still `sending`, so an unsubscribe or a cancel that happens
//     a moment earlier always wins.
//
// The timer in index.js only POLLS the database. Because the timer cannot run while a free Render instance
// is asleep, POST /api/newsletter/worker/tick (secret protected) lets any external scheduler wake the server
// and process due campaigns. See docs/NEWSLETTER_CAMPAIGNS.md.
//
// Mail goes out through the existing Brevo SMTP transporter, one message at a time with a pause between
// messages, never hundreds at once.
// ==========================================

const WORKER_ID = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

const envInt = (name, fallback, min, max) => {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
};

// Defaults are deliberately gentle. DAILY_LIMIT counts campaign e-mails only (order and OTP emails share the
// same Brevo quota); 0 means "no limit of our own".
const config = () => ({
  batchSize: envInt("NEWSLETTER_BATCH_SIZE", 20, 1, 100),
  delayMs: envInt("NEWSLETTER_SEND_DELAY_MS", 1000, 0, 60000),
  dailyLimit: envInt("NEWSLETTER_DAILY_LIMIT", 250, 0, 1000000),
  tickBudgetMs: envInt("NEWSLETTER_TICK_BUDGET_MS", 25000, 1000, 80000),
  maxAttempts: 3,
  backoffMinutes: [5, 30],
  authBackoffMinutes: 10,
  leaseSeconds: 120,
  staleSendingMinutes: 10,
  maxConsecutiveTemporary: 5,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scrub = (text) => {
  let out = String(text || "").replace(/\s+/g, " ");
  for (const secret of [process.env.BREVO_SMTP_KEY, process.env.BREVO_SMTP_USER, process.env.DB_PASSWORD]) {
    if (secret && secret.length > 3) out = out.split(secret).join("***");
  }
  return out.slice(0, 150);
};
const describeError = (error) => `${error.code || error.responseCode || "ERROR"}: ${scrub(error.message)}`.slice(0, 200);

// permanent -> never retry; auth -> our credentials are wrong (pause, do not burn the recipient);
// temporary -> retry later with backoff (connection problems, timeouts, 4xx).
const classifyError = (error) => {
  const rc = Number(error && error.responseCode);
  if ((error && error.code === "EAUTH") || rc === 535 || rc === 534) return "auth";
  if (rc >= 400 && rc < 500) return "temporary";
  if (rc >= 500 && rc < 600) return "permanent";
  if (error && (error.code === "EENVELOPE" || error.code === "EMESSAGE")) return "permanent";
  return "temporary";
};

const isMissingTable = (error) => Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);

const defaultSendMail = (mail) => require("../config/mailer").transporter.sendMail(mail);
const defaultSender = () => require("../config/mailer").getBrevoSender();

// ---- starting a campaign ---------------------------------------------------------------------

const failCampaign = (pool, id, note) =>
  pool.execute(
    `UPDATE newsletter_campaigns
        SET status = 'failed', completed_at = UTC_TIMESTAMP(6), locked_until = NULL, error_note = ?, updated_at = UTC_TIMESTAMP(6)
      WHERE id = ? AND status = 'sending'`,
    [String(note).slice(0, 255), id]
  );

// Renders the frozen e-mail and queues one row per ACTIVE subscriber in the audience. Safe to run twice
// (INSERT IGNORE on the unique campaign+subscriber key), which is what makes a crash here recoverable.
const prepareCampaign = async (pool, row) => {
  const id = String(row.id);
  let out;
  try {
    const ready = await campaigns.assertReady(row, pool, { mode: "send" });
    out = emailDesign.renderEmail(ready.design, { subject: row.subject, preheader: row.preheader, products: ready.products, mode: "send" });
  } catch (error) {
    await failCampaign(pool, id, error.message || "The email could not be prepared.");
    return false;
  }

  const filter = campaigns.audienceFilter(row);
  let after = 0;
  for (;;) {
    const page = await newsletter.listSendable({ afterId: after, limit: 500, ...filter }, { pool });
    if (page.length === 0) break;
    await pool.execute(
      `INSERT IGNORE INTO newsletter_campaign_recipients (campaign_id, subscriber_id, status, created_at, updated_at)
       VALUES ${page.map(() => "(?, ?, 'queued', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))").join(", ")}`,
      page.flatMap((p) => [id, p.id])
    );
    after = page[page.length - 1].id;
    if (page.length < 500) break;
  }

  const [[count]] = await pool.execute("SELECT COUNT(*) AS c FROM newsletter_campaign_recipients WHERE campaign_id = ?", [id]);
  if (Number(count.c) === 0) {
    await failCampaign(pool, id, "There were no active subscribers to send to.");
    return false;
  }
  await pool.execute(
    `UPDATE newsletter_campaigns SET html_snapshot = ?, text_snapshot = ?, total_recipients = ?, updated_at = UTC_TIMESTAMP(6)
      WHERE id = ? AND status = 'sending'`,
    [out.html, out.text, Number(count.c), id]
  );
  return true;
};

// ---- finishing -------------------------------------------------------------------------------

const finalizeIfDone = async (pool, id) => {
  const [[left]] = await pool.execute(
    "SELECT COUNT(*) AS c FROM newsletter_campaign_recipients WHERE campaign_id = ? AND status IN ('queued', 'sending')",
    [id]
  );
  if (Number(left.c) > 0) return null;
  const [[tally]] = await pool.execute(
    "SELECT SUM(sent_at IS NOT NULL) AS sent, SUM(status = 'failed') AS failed FROM newsletter_campaign_recipients WHERE campaign_id = ?",
    [id]
  );
  const sent = Number(tally.sent || 0);
  const failed = Number(tally.failed || 0);
  const status = sent === 0 ? "failed" : failed > 0 ? "partially_failed" : "sent";
  const note = sent === 0 ? "No email was delivered to the mail server." : failed > 0 ? `${failed} email(s) could not be sent.` : null;
  const [result] = await pool.execute(
    `UPDATE newsletter_campaigns
        SET status = ?, completed_at = UTC_TIMESTAMP(6), locked_by = NULL, locked_until = NULL, error_note = ?, updated_at = UTC_TIMESTAMP(6)
      WHERE id = ? AND status = 'sending'`,
    [status, note, id]
  );
  return result.affectedRows === 1 ? status : null;
};

// ---- one campaign ----------------------------------------------------------------------------

const processCampaign = async (pool, id, cfg, deps, deadline) => {
  const result = { sent: 0, failed: 0, skipped: 0, retried: 0, paused: null, finished: null };
  const sendMail = deps.sendMail || defaultSendMail;
  const getSender = deps.sender || defaultSender;
  const buildUnsub = deps.buildUnsubscribe || ((subscriberId) => newsletter.buildUnsubscribe(subscriberId, { pool }));
  const sleepFn = deps.sleep || sleep;

  // Lease: only one worker may work on a campaign at a time.
  const [lease] = await pool.execute(
    `UPDATE newsletter_campaigns
        SET locked_by = ?, locked_until = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND)
      WHERE id = ? AND status = 'sending' AND (locked_until IS NULL OR locked_until < UTC_TIMESTAMP(6) OR locked_by = ?)`,
    [WORKER_ID, cfg.leaseSeconds, id, WORKER_ID]
  );
  if (lease.affectedRows !== 1) return { ...result, paused: "locked" };

  try {
    let [rows] = await pool.execute(
      "SELECT id, subject, html_snapshot, text_snapshot, status, audience_type, audience_source, audience_ids, blocks_json, style_json, preheader FROM newsletter_campaigns WHERE id = ? LIMIT 1",
      [id]
    );
    let campaign = rows[0];
    if (!campaign || campaign.status !== "sending") return result;

    if (!campaign.html_snapshot) {
      if (!(await prepareCampaign(pool, campaign))) return { ...result, finished: "failed" };
      [rows] = await pool.execute("SELECT id, subject, html_snapshot, text_snapshot, status FROM newsletter_campaigns WHERE id = ? LIMIT 1", [id]);
      campaign = rows[0];
      if (!campaign || campaign.status !== "sending") return result;
    }

    const sender = getSender();
    const domain = String(sender.envelopeFrom || "").split("@")[1] || "kovenik.invalid";
    let consecutiveTemporary = 0;

    for (let i = 0; i < cfg.batchSize; i += 1) {
      if (Date.now() > deadline) { result.paused = "time_budget"; break; }

      if (cfg.dailyLimit > 0) {
        const [[today]] = await pool.execute("SELECT COUNT(*) AS c FROM newsletter_campaign_recipients WHERE sent_at >= UTC_DATE()");
        if (Number(today.c) >= cfg.dailyLimit) { result.paused = "daily_limit"; break; }
      }

      const [[state]] = await pool.execute("SELECT status FROM newsletter_campaigns WHERE id = ?", [id]);
      if (!state || state.status !== "sending") break; // cancelled while we were working
      await pool.execute(
        "UPDATE newsletter_campaigns SET locked_until = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND) WHERE id = ? AND locked_by = ?",
        [cfg.leaseSeconds, id, WORKER_ID]
      );

      const [next] = await pool.execute(
        `SELECT id, subscriber_id, attempts FROM newsletter_campaign_recipients
          WHERE campaign_id = ? AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP(6))
          ORDER BY id ASC LIMIT 1`,
        [id]
      );
      if (next.length === 0) break;
      const recipient = next[0];

      // THE gate, immediately before sending: claim this row only if the subscriber is STILL active and the
      // campaign is STILL sending. One atomic statement, so two workers can never claim the same row.
      const [claim] = await pool.execute(
        `UPDATE newsletter_campaign_recipients r
           JOIN newsletter_subscribers s ON s.id = r.subscriber_id
           JOIN newsletter_campaigns c ON c.id = r.campaign_id
            SET r.status = 'sending', r.attempts = r.attempts + 1, r.claimed_at = UTC_TIMESTAMP(6), r.updated_at = UTC_TIMESTAMP(6)
          WHERE r.id = ? AND r.status = 'queued' AND s.status = 'active' AND c.status = 'sending'`,
        [recipient.id]
      );
      if (claim.affectedRows !== 1) {
        const [skip] = await pool.execute(
          `UPDATE newsletter_campaign_recipients r JOIN newsletter_subscribers s ON s.id = r.subscriber_id
              SET r.status = 'skipped', r.error_kind = 'not_active', r.last_error = 'Subscriber is no longer active', r.updated_at = UTC_TIMESTAMP(6)
            WHERE r.id = ? AND r.status = 'queued' AND s.status <> 'active'`,
          [recipient.id]
        );
        result.skipped += skip.affectedRows;
        continue;
      }
      const attempt = Number(recipient.attempts) + 1;

      const [people] = await pool.execute("SELECT email FROM newsletter_subscribers WHERE id = ? LIMIT 1", [recipient.subscriber_id]);
      const email = people[0] && people[0].email;
      try {
        if (!email) throw Object.assign(new Error("Subscriber record is missing."), { code: "EMESSAGE" });

        // A fresh single-use unsubscribe token for THIS e-mail. Only its hash is stored on the delivery row
        // (before sending, so even an interrupted send keeps the link between e-mail and token).
        const unsub = await buildUnsub(recipient.subscriber_id);
        const messageId = `<kv-c${id}-r${recipient.id}@${domain}>`;
        await pool.execute(
          "UPDATE newsletter_campaign_recipients SET unsub_token_hash = ?, message_id = ? WHERE id = ?",
          [newsletter.sha256(unsub.token), messageId.slice(0, 190), recipient.id]
        );

        await sendMail({
          from: sender.from,
          envelope: { from: sender.envelopeFrom, to: email },
          to: email,
          subject: campaign.subject,
          text: emailDesign.fillUnsubscribe(campaign.text_snapshot, unsub.url),
          html: emailDesign.fillUnsubscribe(campaign.html_snapshot, unsub.url),
          messageId, // the same id on a retry, so a duplicate delivery is recognisable as one message
          headers: {
            "List-Unsubscribe": unsub.headers["List-Unsubscribe"],
            "List-Unsubscribe-Post": unsub.headers["List-Unsubscribe-Post"],
            "X-Mailin-Tag": `kv-c${id}`,
            Precedence: "bulk",
          },
        });

        await pool.execute(
          `UPDATE newsletter_campaign_recipients
              SET status = 'sent', sent_at = UTC_TIMESTAMP(6), error_kind = NULL, last_error = NULL, next_attempt_at = NULL, updated_at = UTC_TIMESTAMP(6)
            WHERE id = ? AND status = 'sending'`,
          [recipient.id]
        );
        result.sent += 1;
        consecutiveTemporary = 0;
      } catch (error) {
        const kind = classifyError(error);
        const message = describeError(error);
        console.error("Newsletter email failed:", kind, "|", error.code || error.responseCode || "error"); // never the address or secrets

        if (kind === "permanent") {
          await pool.execute(
            "UPDATE newsletter_campaign_recipients SET status = 'failed', error_kind = 'permanent', last_error = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND status = 'sending'",
            [message, recipient.id]
          );
          result.failed += 1;
        } else if (kind === "auth") {
          // Our own credentials are wrong: nobody should lose an attempt over it. Put the row back and stop.
          await pool.execute(
            `UPDATE newsletter_campaign_recipients
                SET status = 'queued', attempts = GREATEST(attempts - 1, 0), error_kind = 'temporary', last_error = ?,
                    next_attempt_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? MINUTE), updated_at = UTC_TIMESTAMP(6)
              WHERE id = ? AND status = 'sending'`,
            [message, cfg.authBackoffMinutes, recipient.id]
          );
          result.paused = "mail_auth_failed";
          break;
        } else if (attempt >= cfg.maxAttempts) {
          await pool.execute(
            "UPDATE newsletter_campaign_recipients SET status = 'failed', error_kind = 'temporary', last_error = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND status = 'sending'",
            [`${message} (gave up after ${attempt} attempts)`.slice(0, 200), recipient.id]
          );
          result.failed += 1;
          consecutiveTemporary += 1;
        } else {
          const wait = cfg.backoffMinutes[Math.min(attempt - 1, cfg.backoffMinutes.length - 1)];
          await pool.execute(
            `UPDATE newsletter_campaign_recipients
                SET status = 'queued', error_kind = 'temporary', last_error = ?,
                    next_attempt_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? MINUTE), updated_at = UTC_TIMESTAMP(6)
              WHERE id = ? AND status = 'sending'`,
            [message, wait, recipient.id]
          );
          result.retried += 1;
          consecutiveTemporary += 1;
        }
        // A run of temporary failures means the mail server is having trouble: stop and try again next tick.
        if (consecutiveTemporary >= cfg.maxConsecutiveTemporary) { result.paused = "mail_server_trouble"; break; }
      }

      if (cfg.delayMs > 0) await sleepFn(cfg.delayMs);
    }

    result.finished = await finalizeIfDone(pool, id);
    return result;
  } finally {
    await pool
      .execute("UPDATE newsletter_campaigns SET locked_until = NULL WHERE id = ? AND locked_by = ?", [id, WORKER_ID])
      .catch(() => {});
  }
};

// ---- the tick --------------------------------------------------------------------------------

let running = false;

const processTick = async (deps = {}) => {
  if (running) return { skipped: "busy" };
  running = true;
  try {
    const pool = deps.pool || (await poolPromise);
    const cfg = { ...config(), ...(deps.config || {}) };
    const deadline = Date.now() + cfg.tickBudgetMs;
    const summary = { recovered: 0, started: 0, campaigns: 0, sent: 0, failed: 0, skipped: 0, retried: 0, paused: [] };

    // A recipient stuck in "sending" means the server died mid-send. Whether that e-mail left is unknown, so it is
    // NOT retried (that could send a duplicate); it is recorded as interrupted and counted as failed.
    const [stale] = await pool.execute(
      `UPDATE newsletter_campaign_recipients
          SET status = 'failed', error_kind = 'interrupted', last_error = 'Interrupted while sending; delivery unknown, not retried to avoid a duplicate.',
              updated_at = UTC_TIMESTAMP(6)
        WHERE status = 'sending' AND claimed_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ? MINUTE)`,
      [cfg.staleSendingMinutes]
    );
    summary.recovered = stale.affectedRows;

    // Scheduled campaigns whose time has come (also catches anything that came due while the server was down).
    const [due] = await pool.execute(
      "SELECT id FROM newsletter_campaigns WHERE status = 'scheduled' AND scheduled_at <= UTC_TIMESTAMP(6) ORDER BY scheduled_at ASC LIMIT 5"
    );
    for (const row of due) {
      const [claim] = await pool.execute(
        `UPDATE newsletter_campaigns SET status = 'sending', started_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
          WHERE id = ? AND status = 'scheduled' AND scheduled_at <= UTC_TIMESTAMP(6)`,
        [row.id]
      );
      summary.started += claim.affectedRows;
    }

    const [active] = await pool.execute("SELECT id FROM newsletter_campaigns WHERE status = 'sending' ORDER BY id ASC LIMIT 5");
    for (const row of active) {
      if (Date.now() > deadline) break;
      let r;
      try {
        r = await processCampaign(pool, String(row.id), cfg, deps, deadline);
      } catch (error) {
        // One broken campaign (for example the mail settings are missing) must not stop the others.
        console.error("Newsletter campaign processing failed:", String(row.id), "|", error.code || error.message);
        summary.paused.push({ campaign: String(row.id), reason: "error" });
        continue;
      }
      summary.campaigns += 1;
      summary.sent += r.sent; summary.failed += r.failed; summary.skipped += r.skipped; summary.retried += r.retried;
      if (r.paused) summary.paused.push({ campaign: String(row.id), reason: r.paused });
    }
    return summary;
  } catch (error) {
    if (isMissingTable(error)) return { skipped: "not_available" };
    throw error;
  } finally {
    running = false;
  }
};

// Starts a tick without making the caller wait.
const kick = () => {
  setImmediate(() => processTick().catch((error) => console.error("Newsletter tick failed:", error.message)));
};

// Polls the database on a timer. This is only a convenience: the schedule itself is in MySQL.
const startWorker = () => {
  const run = () =>
    processTick().catch((error) => {
      if (!isMissingTable(error)) console.error("Newsletter tick failed:", error.message);
    });
  setTimeout(run, 20 * 1000).unref();
  setInterval(run, 30 * 1000).unref();
};

// ---- provider (Brevo) webhook ----------------------------------------------------------------
//
// Brevo posts transactional events. We use only delivery facts, matched through the tag we put on every
// campaign e-mail (X-Mailin-Tag: kv-c<campaign id>) plus the recipient address:
//   delivered                              -> delivered_at
//   hard_bounce / invalid_email / blocked  -> bounced_at, and the subscriber is suppressed (status 'bounced')
//   spam (complaint)                       -> the subscriber is suppressed (status 'complained')
//   unsubscribed                           -> the subscriber is unsubscribed
// Opens and clicks are ignored on purpose. Repeated calls are harmless (event_key is unique).

const EVENT_MAP = {
  delivered: "delivered",
  hard_bounce: "bounced", invalid_email: "bounced", invalid: "bounced", blocked: "bounced",
  spam: "complaint", complaint: "complaint",
  unsubscribed: "unsubscribed", unsubscribe: "unsubscribed",
};

const campaignIdFromTag = (ev) => {
  const candidates = [ev.tag, ...(Array.isArray(ev.tags) ? ev.tags : [])].filter((t) => typeof t === "string");
  for (const t of candidates) {
    const m = /^kv-c(\d{1,18})$/.exec(t);
    if (m) return m[1];
  }
  return null;
};

const handleProviderEvents = async (payload, deps = {}) => {
  const pool = deps.pool || (await poolPromise);
  const events = (Array.isArray(payload) ? payload : [payload]).filter((e) => e && typeof e === "object").slice(0, 200);
  const result = { received: events.length, applied: 0, ignored: 0, duplicate: 0 };

  for (const ev of events) {
    const type = EVENT_MAP[String(ev.event || "").toLowerCase()];
    const campaignId = campaignIdFromTag(ev);
    const email = typeof ev.email === "string" ? ev.email.trim().toLowerCase().slice(0, 254) : "";
    if (!type || !campaignId || !email) { result.ignored += 1; continue; }

    const [found] = await pool.execute(
      `SELECT r.id, r.subscriber_id FROM newsletter_campaign_recipients r
         JOIN newsletter_subscribers s ON s.id = r.subscriber_id
        WHERE r.campaign_id = ? AND s.email = ? LIMIT 1`,
      [campaignId, email]
    );
    if (found.length === 0) { result.ignored += 1; continue; }
    const { id: recipientId, subscriber_id: subscriberId } = found[0];

    const stamp = ev.ts_event || ev.ts_epoch || ev.ts || ev.date || "";
    const eventKey = crypto.createHash("sha256").update(`${campaignId}|${email}|${type}|${stamp}`).digest("hex");
    const occurred = Number(ev.ts_event || ev.ts_epoch) > 1e9 ? new Date(Number(ev.ts_event || ev.ts_epoch) * 1000) : null;
    const [inserted] = await pool.execute(
      `INSERT IGNORE INTO newsletter_events (campaign_id, recipient_id, event, event_key, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
      [campaignId, recipientId, type, eventKey, occurred && !Number.isNaN(occurred.getTime()) ? occurred.toISOString().replace("T", " ").replace("Z", "") : null]
    );
    if (inserted.affectedRows !== 1) { result.duplicate += 1; continue; }

    if (type === "delivered") {
      await pool.execute("UPDATE newsletter_campaign_recipients SET delivered_at = COALESCE(delivered_at, UTC_TIMESTAMP(6)) WHERE id = ?", [recipientId]);
    } else if (type === "bounced") {
      await pool.execute(
        "UPDATE newsletter_campaign_recipients SET bounced_at = COALESCE(bounced_at, UTC_TIMESTAMP(6)), error_kind = 'bounced' WHERE id = ?",
        [recipientId]
      );
      await pool.execute("UPDATE newsletter_subscribers SET status = 'bounced', updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND status IN ('active', 'pending')", [subscriberId]);
    } else if (type === "complaint") {
      await pool.execute("UPDATE newsletter_subscribers SET status = 'complained', updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND status IN ('active', 'pending')", [subscriberId]);
    } else if (type === "unsubscribed") {
      await pool.execute(
        "UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND status IN ('active', 'pending')",
        [subscriberId]
      );
    }
    result.applied += 1;
  }
  return result;
};

module.exports = {
  processTick, processCampaign, kick, startWorker, handleProviderEvents,
  classifyError, describeError, config, WORKER_ID,
};
