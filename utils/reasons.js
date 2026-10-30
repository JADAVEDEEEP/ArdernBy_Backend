// Fixed lists used by cancellations, returns and inspections. The server only
// accepts these codes; the screens ask the API for the labels so there is one
// source of truth.

const CUSTOMER_CANCEL_REASONS = [
  { code: "changed_mind", label: "I changed my mind" },
  { code: "ordered_by_mistake", label: "I ordered by mistake" },
  { code: "found_cheaper", label: "I found a better price elsewhere" },
  { code: "wrong_size_ordered", label: "I chose the wrong size or colour" },
  { code: "delivery_too_slow", label: "Delivery is taking too long" },
  { code: "payment_issue", label: "A problem with my payment" },
  { code: "other", label: "Other (please explain)" },
];

const ADMIN_CANCEL_REASONS = [
  { code: "customer_request", label: "Customer asked us to cancel" },
  { code: "out_of_stock", label: "Item is out of stock" },
  { code: "address_issue", label: "Delivery address problem" },
  { code: "suspected_fraud", label: "Suspected fraud" },
  { code: "payment_issue", label: "Payment problem" },
  { code: "other", label: "Other (please explain)" },
];

const RETURN_REASONS = [
  { code: "wrong_product", label: "Wrong product received" },
  { code: "wrong_size", label: "Wrong size" },
  { code: "damaged", label: "Damaged product" },
  { code: "defective", label: "Defective product" },
  { code: "quality_issue", label: "Product quality issue" },
  { code: "not_as_described", label: "Product different from description" },
  { code: "other", label: "Other (please explain)" },
];

const INSPECTION_RESULTS = [
  { code: "unused_original", label: "Unused, original condition" },
  { code: "damaged", label: "Damaged" },
  { code: "defective", label: "Defective" },
  { code: "used_washed", label: "Used or washed" },
  { code: "incorrect_item", label: "Incorrect product returned" },
  { code: "other", label: "Other" },
];

const MANUAL_REFUND_METHODS = [
  { code: "upi", label: "UPI" },
  { code: "bank_transfer", label: "Bank transfer" },
  { code: "cash", label: "Cash" },
  { code: "other", label: "Other" },
];

const codes = (list) => list.map((item) => item.code);

module.exports = {
  CUSTOMER_CANCEL_REASONS,
  ADMIN_CANCEL_REASONS,
  RETURN_REASONS,
  INSPECTION_RESULTS,
  MANUAL_REFUND_METHODS,
  codes,
  label: (list, code) => list.find((item) => item.code === code)?.label || code,
};
