// ==========================================
// REFUND AMOUNTS AS SQL, FOR THE REPORTS
//
// Reports that sum "what was refunded" must not assume a refund is always the
// whole order total any more: a partial cancellation or return refunds only part.
// For an order aliased `o` these expressions give, in rupees:
//
//   refunded   confirmed paid back: the completed refunds of the item-level flow,
//              or (original whole-order cancel, no such records) the whole total
//              when payment_status is Refunded
//   open       promised but not confirmed: pending / processing / failed refunds,
//              or (original flow) the whole total while Refund Pending
//   net        what the order is worth after confirmed refunds
//
// The item-level tables were created with the server's default collation (utf8mb4_0900_ai_ci) while
// orders uses utf8mb4_unicode_ci; MySQL refuses to compare the two columns directly, so the
// comparison names the collation explicitly.
//
// Until the phase 3 migration exists the item-level tables are not there; then
// only the payment-status rule applies (exactly what the reports did before).
// `refresh()` is awaited at the start of a report; the getters are plain strings.
// ==========================================

const isMissingTable = (error) => Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);

const STATUS_ONLY = {
  refunded: "(CASE WHEN LOWER(o.payment_status) = 'refunded' THEN o.total_amount ELSE 0 END)",
  open: "(CASE WHEN LOWER(o.payment_status) = 'refund pending' THEN o.total_amount ELSE 0 END)",
};

const done = `(COALESCE((SELECT SUM(c.refund_amount) FROM order_cancellations c WHERE c.order_id COLLATE utf8mb4_unicode_ci = o.id AND c.refund_status = 'completed'), 0)
  + COALESCE((SELECT SUM(r.refund_amount) FROM return_requests r WHERE r.order_id COLLATE utf8mb4_unicode_ci = o.id AND r.refund_status = 'completed'), 0))`;
const open = `(COALESCE((SELECT SUM(c.refund_amount) FROM order_cancellations c WHERE c.order_id COLLATE utf8mb4_unicode_ci = o.id AND c.refund_status IN ('pending', 'processing', 'failed')), 0)
  + COALESCE((SELECT SUM(r.refund_amount) FROM return_requests r WHERE r.order_id COLLATE utf8mb4_unicode_ci = o.id AND r.refund_status IN ('pending', 'processing', 'failed')), 0))`;

const ITEM_LEVEL = {
  refunded: `GREATEST(${done}, ${STATUS_ONLY.refunded})`,
  open: `GREATEST(${open}, CASE WHEN LOWER(o.payment_status) = 'refund pending' AND ${open} = 0 AND ${done} = 0 THEN o.total_amount ELSE 0 END)`,
};

let current = STATUS_ONLY;
let itemLevel = false;
let checkedAt = 0;
const RECHECK_MS = 30 * 1000;

const refresh = async (executor) => {
  if (itemLevel) return current;
  if (Date.now() - checkedAt < RECHECK_MS) return current;
  try {
    await executor.execute("SELECT 1 FROM order_cancellations LIMIT 1");
    itemLevel = true;
    current = ITEM_LEVEL;
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    itemLevel = false;
    current = STATUS_ONLY;
  }
  checkedAt = Date.now();
  return current;
};

const refunded = () => current.refunded;
const openRefund = () => current.open;
const net = () => `(o.total_amount - ${current.refunded})`;

const resetCache = () => {
  current = STATUS_ONLY;
  itemLevel = false;
  checkedAt = 0;
};

module.exports = { refresh, refunded, openRefund, net, resetCache };
