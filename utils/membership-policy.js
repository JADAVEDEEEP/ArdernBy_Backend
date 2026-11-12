// Pure rules shared by the purchase flow and tests.
//
// KOVENIK has ONE membership plan (KOVENIK MEMBER). The old Bronze / Silver / Gold rows
// are retired (hidden, never deleted) but terms already bought on them keep running.
//
// Policy:
//  - no current membership   -> "new", starts now
//  - already a member        -> "renew", starts when the current term ends (one queued renewal at most)
//  - renewal already queued  -> blocked
// A customer on a legacy term may also buy KOVENIK MEMBER: it queues behind the term they
// already paid for, so nothing they bought is cut short.

const DAY_MS = 24 * 60 * 60 * 1000;

// The only plan customers can buy.
const MEMBER_PLAN_SLUG = "kovenik-member";
const MEMBER_PLAN_NAME = "KOVENIK MEMBER";

const addDays = (date, days) => new Date(new Date(date).getTime() + Number(days) * DAY_MS);

// current / queued: { end_date } | null.
const decidePurchase = ({ current, queued, now = new Date() }) => {
  if (!current) return { action: "new", startDate: now };

  if (queued) {
    return { action: "blocked", reason: "Your membership is already renewed." };
  }

  return { action: "renew", startDate: new Date(current.end_date) };
};

module.exports = { DAY_MS, MEMBER_PLAN_SLUG, MEMBER_PLAN_NAME, addDays, decidePurchase };
