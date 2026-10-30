// ==========================================
// WHEN AN ORDER WAS DELIVERED (start of the return window)
//
// The orders table has no delivered-at column, so the moment an admin sets the
// status to Delivered is kept in order_delivery_log (added by the phase 3
// migration). Orders delivered before that fall back to their last update time,
// which is what the window used before: never worse than before, exact from now on.
// Until the migration is applied nothing is recorded and the fallback applies.
// ==========================================

const isMissingTable = (error) => Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);

let known = null; // true once seen; false results are re-checked after a while
let checkedAt = 0;
const RECHECK_MS = 30 * 1000;

const logExists = async (executor) => {
  if (known === true) return true;
  if (known === false && Date.now() - checkedAt < RECHECK_MS) return false;
  try {
    await executor.execute("SELECT 1 FROM order_delivery_log LIMIT 1");
    known = true;
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    known = false;
  }
  checkedAt = Date.now();
  return known;
};

// Seconds since delivery, as a SQL column for a query "FROM orders" (unaliased).
const ageSql = async (executor) =>
  (await logExists(executor))
    ? "TIMESTAMPDIFF(SECOND, COALESCE((SELECT d.delivered_at FROM order_delivery_log d WHERE d.order_id COLLATE utf8mb4_unicode_ci = orders.id), updated_at), UTC_TIMESTAMP(6)) AS age_seconds"
    : "TIMESTAMPDIFF(SECOND, updated_at, UTC_TIMESTAMP(6)) AS age_seconds";

// Called right after an order's status became Delivered.
const recordDelivered = async (executor, orderId, actorId = null) => {
  try {
    if (!(await logExists(executor))) return false;
    await executor.execute(
      `INSERT INTO order_delivery_log (order_id, delivered_at, recorded_by)
       VALUES (?, UTC_TIMESTAMP(6), ?)
       ON DUPLICATE KEY UPDATE delivered_at = VALUES(delivered_at), recorded_by = VALUES(recorded_by)`,
      [orderId, actorId]
    );
    return true;
  } catch (error) {
    // The status change already happened; the window then falls back to updated_at.
    console.error("Could not record the delivery time:", error.code || error.message);
    return false;
  }
};

const resetCache = () => {
  known = null;
  checkedAt = 0;
};

module.exports = { ageSql, recordDelivered, resetCache };
