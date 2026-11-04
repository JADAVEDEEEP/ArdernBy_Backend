// Pure rules shared by the purchase flow and tests.
//
// Policy (agreed 2026-11-02):
//  - no current membership        -> "new", starts now
//  - same tier as current         -> "renew", starts when the current term ends (one queued renewal at most)
//  - higher tier than current     -> "upgrade", starts now; the lower one is ended (no pro-rata credit)
//  - lower tier than current      -> blocked

const DAY_MS = 24 * 60 * 60 * 1000;

const addDays = (date, days) => new Date(new Date(date).getTime() + Number(days) * DAY_MS);

// current / queued: { tier_rank, end_date } | null. target: { tier_rank }.
const decidePurchase = ({ current, queued, target, now = new Date() }) => {
  if (!current) return { action: "new", startDate: now };

  if (Number(target.tier_rank) < Number(current.tier_rank)) {
    return { action: "blocked", reason: "You already have a higher membership active." };
  }

  if (Number(target.tier_rank) > Number(current.tier_rank)) {
    return { action: "upgrade", startDate: now };
  }

  if (queued) {
    return { action: "blocked", reason: "Your membership is already renewed." };
  }

  return { action: "renew", startDate: new Date(current.end_date) };
};

module.exports = { DAY_MS, addDays, decidePurchase };
