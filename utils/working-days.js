// Refund timing shown to customers: "5-7 working days after inspection and refund
// approval". Working days are Monday to Friday; public holidays are not modelled, so
// the dates are an estimate and always shown as such.

const REFUND_DAYS_MIN = 5;
const REFUND_DAYS_MAX = 7;
const REFUND_WINDOW_TEXT = `${REFUND_DAYS_MIN}–${REFUND_DAYS_MAX} working days after your return is inspected and the refund is approved`;

// Adds `days` working days to a date (UTC based; the result is a date, not a time).
const addWorkingDays = (from, days) => {
  const date = new Date(from);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCHours(0, 0, 0, 0);
  let left = Math.max(0, Math.floor(days));
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return date;
};

// { from, to } ISO dates (yyyy-mm-dd) counted from `base`, or null when there is no base.
const refundWindow = (base) => {
  if (!base) return null;
  const from = addWorkingDays(base, REFUND_DAYS_MIN);
  const to = addWorkingDays(base, REFUND_DAYS_MAX);
  if (!from || !to) return null;
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
};

module.exports = { REFUND_DAYS_MIN, REFUND_DAYS_MAX, REFUND_WINDOW_TEXT, addWorkingDays, refundWindow };
