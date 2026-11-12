const { REFUND_WINDOW_TEXT, refundWindow } = require("../utils/working-days");

// ==========================================
// CUSTOMER RETURN & REFUND TIMELINE
//
// Pure: it only READS what is already stored (the return row, its status history, and
// the payout / refund ids that Razorpay / RazorpayX webhooks wrote). A stage is "done"
// only when the stored state proves its event happened; nothing is predicted. Admin
// actions, customer actions and webhooks all change those stored rows, so the timeline
// is always in step with them: it is rebuilt from them on every request.
// ==========================================

const RANK = { Requested: 0, Approved: 1, Shipped: 2, Received: 3, Inspected: 4, Completed: 5 };

const iso = (value) => {
  if (!value) return null;
  if (typeof value === "string" && /Z$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const firstAt = (history, status) => {
  const entry = history.find((h) => h.to_status === status);
  return entry ? iso(entry.created_iso || entry.created_at) : null;
};

// The history entry written when the refund was decided ("Refund sent for processing ...").
const refundApprovedAt = (history) => {
  const entry = [...history].reverse().find((h) => h.to_status === "Inspected" && /^Refund /.test(String(h.note || "")));
  return entry ? iso(entry.created_iso || entry.created_at) : null;
};

const stage = (key, label, state, at = null, note = null) => ({ key, label, state, at, note });

// row: return_requests row (+ *_iso columns); history: return_status_history rows.
const buildTimeline = ({ row, history = [], refundLabel = null }) => {
  const rank = RANK[row.status];
  const rejected = row.status === "Rejected";
  const stages = [];

  stages.push(stage("requested", "Return requested", "done", iso(row.created_iso)));

  if (rejected) {
    stages.push(stage("decision", "Return rejected", "rejected", iso(row.decided_iso) || firstAt(history, "Rejected"), row.decision_reason || null));
    return { outcome: "rejected", currentKey: null, stages, estimate: null };
  }

  const reached = (needed) => rank !== undefined && rank >= needed;
  const refundStatus = row.refund_status || null;
  const completed = refundStatus === "completed";
  const failed = refundStatus === "failed";
  // Finished with no refund decision at all = nothing qualified, so there is no refund to track.
  const noRefund = refundStatus === "not_applicable" || (row.status === "Completed" && !refundStatus);

  stages.push(
    reached(1)
      ? stage("decision", "Return approved", "done", iso(row.decided_iso) || firstAt(history, "Approved"))
      : stage("decision", "Approval pending", "upcoming")
  );
  stages.push(stage("shipped", "Items sent back", reached(2) ? "done" : "upcoming", reached(2) ? iso(row.shipped_iso) || firstAt(history, "Shipped") : null));
  stages.push(stage("received", "Items received", reached(3) ? "done" : "upcoming", reached(3) ? iso(row.received_iso) || firstAt(history, "Received") : null));
  stages.push(stage("inspection", "Quality inspection", reached(4) ? "done" : "upcoming", reached(4) ? iso(row.inspected_iso) || firstAt(history, "Inspected") : null));

  const approvedAt = refundStatus && !noRefund ? refundApprovedAt(history) : null;
  if (noRefund) {
    stages.push(stage("refund_approved", "No refund due", "skipped", null, "None of the items qualified for a refund."));
  } else {
    stages.push(stage("refund_approved", "Refund approved", refundStatus ? "done" : "upcoming", approvedAt));
  }

  if (!noRefund) {
    const sent = Boolean(row.payout_id || row.refund_id || row.payout_initiated_at);
    const processingDone = completed || (failed && sent);
    stages.push(
      stage(
        "refund_processing",
        "Refund processing",
        processingDone ? "done" : "upcoming",
        processingDone ? iso(row.payout_initiated_at) : null
      )
    );

    if (failed) {
      stages.push(stage("refund_final", "Refund failed", "failed", null, "Your refund could not be sent yet. We are retrying it, or we will contact you. You do not need to do anything."));
    } else if (completed) {
      stages.push(stage("refund_final", "Refund completed", "done", iso(row.refund_completed_at) || iso(row.completed_iso)));
    } else {
      stages.push(stage("refund_final", "Refund completed", "upcoming"));
    }
  }

  // The first stage that has not happened yet is "current" (unless something failed).
  if (!failed) {
    const next = stages.find((s) => s.state === "upcoming");
    if (next) next.state = "current";
  }

  const base = approvedAt || (reached(4) ? iso(row.inspected_iso) || firstAt(history, "Inspected") : null);
  const estimate =
    completed || noRefund
      ? null
      : { text: REFUND_WINDOW_TEXT, basis: approvedAt ? "approval" : base ? "inspection" : null, ...(refundWindow(base) || {}) };

  const current = stages.find((s) => s.state === "current" || s.state === "failed");
  return {
    outcome: failed ? "refund_failed" : completed ? "completed" : noRefund && reached(4) ? "completed" : "in_progress",
    currentKey: current ? current.key : null,
    stages,
    estimate,
    refundLabel,
  };
};

module.exports = { buildTimeline };
