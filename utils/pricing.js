// Single source of truth for order pricing.
// Mirrors ArdenBy/lib/pricing.ts — keep both in sync.

// TEMPORARY shipping rule (until the Shiprocket integration): a flat fee per order for
// everyone, free for an ACTIVE KOVENIK member (old Gold terms included). No minimum order
// value and no free-shipping threshold. Membership is decided by the backend only.
const SHIPPING_FEE = 49;
const GST_RATE = 0.05;

// Cash on delivery: a flat handling fee (plus GST) on COD orders only, and COD is
// offered only while the goods value (after any coupon, before GST / shipping / this
// fee) is at most COD_MAX_ORDER_VALUE. The fee is never refunded on a return.
const COD_FEE = 29;
const COD_MAX_ORDER_VALUE = 3000;
const COD_LIMIT_MESSAGE =
  "COD is available only for orders up to ₹3,000. Please choose online payment.";

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

// COD is allowed while the goods value (taxable amount) is within the limit.
const isCodAllowed = (taxableAmount) => roundMoney(taxableAmount) <= COD_MAX_ORDER_VALUE;

// subtotal - couponDiscount = taxable amount; GST on taxable amount;
// shipping is a flat fee unless options.freeShipping (active member) waives it.
// options.cod adds the COD handling fee and its GST (never on prepaid orders).
const calculateOrderTotals = (subtotal, couponDiscount = 0, options = {}) => {
  const safeSubtotal = roundMoney(subtotal);
  const discountAmount = roundMoney(
    Math.max(0, Math.min(Number(couponDiscount) || 0, safeSubtotal))
  );
  const taxableAmount = roundMoney(safeSubtotal - discountAmount);
  const shippingAmount =
    safeSubtotal === 0 || options.freeShipping === true ? 0 : SHIPPING_FEE;
  const taxAmount = Math.round(taxableAmount * GST_RATE);
  const codFee = options.cod === true && safeSubtotal > 0 ? COD_FEE : 0;
  const codFeeTax = roundMoney(codFee * GST_RATE);
  const totalAmount = roundMoney(
    taxableAmount + shippingAmount + taxAmount + codFee + codFeeTax
  );

  return {
    subtotal: safeSubtotal,
    discountAmount,
    taxableAmount,
    shippingAmount,
    taxAmount,
    codFee,
    codFeeTax,
    totalAmount,
  };
};

module.exports = {
  SHIPPING_FEE,
  GST_RATE,
  COD_FEE,
  COD_MAX_ORDER_VALUE,
  COD_LIMIT_MESSAGE,
  isCodAllowed,
  roundMoney,
  calculateCouponDiscount,
  calculateOrderTotals,
};
