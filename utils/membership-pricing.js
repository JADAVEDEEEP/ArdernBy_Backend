// Pure member-price maths. The server is the only place that decides what is payable.
const { roundMoney } = require("./pricing");

const DEFAULT_MAX_TOTAL_DISCOUNT_PERCENT = 60;

// price = current selling price (a sale price is already applied), mrp = list price.
// rule = optional { eligible, member_price } for (plan, product). Never returns more than price.
//
// The member discount is an ADDITIONAL percentage off the CURRENT SELLING PRICE, so it applies
// on sale items too (selling price 1000 -> member price 850 at 15%). It is applied exactly once:
// `price` here is the product's own selling price, never an already-member-discounted one.
// A fixed per-product member price (admin rule) replaces the percentage, it is not added to it.
//
// Limit: sale + member (and, in capCouponDiscount below, coupons) can never take more than
// maxTotalDiscountPercent off the list price, so on a deeply discounted item the member price
// stops at that floor.
const memberUnitPrice = ({ price, mrp, discountPercent, rule, maxTotalDiscountPercent }) => {
  const base = roundMoney(Number(price));
  if (rule && Number(rule.eligible) === 0) return base;

  const candidate =
    rule && rule.member_price != null
      ? roundMoney(Number(rule.member_price))
      : roundMoney(base * (1 - Number(discountPercent || 0) / 100));

  let result = Math.min(base, candidate);

  const list = Number(mrp);
  const cap = Number(maxTotalDiscountPercent ?? DEFAULT_MAX_TOTAL_DISCOUNT_PERCENT);
  if (Number.isFinite(list) && list > 0 && Number.isFinite(cap)) {
    result = Math.max(result, roundMoney(list * (1 - cap / 100)));
  }

  return roundMoney(Math.min(base, result));
};

// Coupon discount that keeps (list price - payable) within the cap. listSubtotal = sum of mrp * qty.
const capCouponDiscount = ({ couponDiscount, listSubtotal, payableSubtotal, maxTotalDiscountPercent }) => {
  const cap = Number(maxTotalDiscountPercent ?? DEFAULT_MAX_TOTAL_DISCOUNT_PERCENT);
  const allowedTotal = roundMoney((Number(listSubtotal) * cap) / 100);
  const alreadyGiven = Math.max(0, Number(listSubtotal) - Number(payableSubtotal));
  const room = Math.max(0, roundMoney(allowedTotal - alreadyGiven));
  return roundMoney(Math.min(Number(couponDiscount) || 0, room));
};

module.exports = { DEFAULT_MAX_TOTAL_DISCOUNT_PERCENT, memberUnitPrice, capCouponDiscount };
