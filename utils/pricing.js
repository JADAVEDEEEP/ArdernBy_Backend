// Single source of truth for order pricing.
// Mirrors ArdenBy/lib/pricing.ts — keep both in sync.

const FREE_SHIPPING_THRESHOLD = 999;
const SHIPPING_FEE = 79;
const GST_RATE = 0.05;

const roundMoney = (value) =>
  Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;

// Coupon discount for a given subtotal. Assumes the coupon is already
// verified as active / unexpired / min_order satisfied.
const calculateCouponDiscount = (coupon, subtotal) => {
  const type = String(coupon.discount_type || "").toLowerCase();
  let discount = 0;

  if (type === "percentage") {
    discount = (subtotal * Number(coupon.discount_value)) / 100;

    // The column defaults to 0, which means "no cap" (same as NULL).
    const cap = Number(coupon.max_discount);
    if (coupon.max_discount != null && Number.isFinite(cap) && cap > 0) {
      discount = Math.min(discount, cap);
    }
  } else if (type === "flat") {
    discount = Number(coupon.discount_value);
  } else {
    throw new Error("Invalid discount type.");
  }

  return roundMoney(Math.max(0, Math.min(discount, subtotal)));
};

// subtotal - couponDiscount = taxable amount; GST on taxable amount;
// shipping depends on the pre-coupon subtotal.
const calculateOrderTotals = (subtotal, couponDiscount = 0) => {
  const safeSubtotal = roundMoney(subtotal);
  const discountAmount = roundMoney(
    Math.max(0, Math.min(Number(couponDiscount) || 0, safeSubtotal))
  );
  const taxableAmount = roundMoney(safeSubtotal - discountAmount);
  const shippingAmount =
    safeSubtotal === 0 || safeSubtotal >= FREE_SHIPPING_THRESHOLD
      ? 0
      : SHIPPING_FEE;
  const taxAmount = Math.round(taxableAmount * GST_RATE);
  const totalAmount = roundMoney(taxableAmount + shippingAmount + taxAmount);

  return {
    subtotal: safeSubtotal,
    discountAmount,
    taxableAmount,
    shippingAmount,
    taxAmount,
    totalAmount,
  };
};

module.exports = {
  FREE_SHIPPING_THRESHOLD,
  SHIPPING_FEE,
  GST_RATE,
  roundMoney,
  calculateCouponDiscount,
  calculateOrderTotals,
};
