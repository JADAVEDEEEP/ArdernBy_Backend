// ==========================================
// REFUND CALCULATION (the single source of truth)
//
// Everything is whole paise (integers), never floating rupees.
//
// How an order is priced (utils/pricing.js):
//   subtotal = sum(unit_price x quantity)
//   total    = subtotal - coupon discount + shipping + GST
// so what a customer paid for ONE LINE of goods is
//   its gross price - its share of the order discount + its share of the GST.
//
// Shares are allocated across the lines in proportion to their gross price with
// the "largest remainder" method, so the shares always add up to the order's
// discount and GST to the paisa. Units inside one line are then priced
// cumulatively: refunding units u+1..u+k of a line is cum(u+k) - cum(u). That
// makes any sequence of partial cancellations / returns add up to exactly the
// line's total, never more, never a paisa short.
//
// Shipping is refunded only when the caller says so (a cancellation that cancels
// the last remaining items of an order before dispatch). A deduction can only
// REDUCE a refund and needs a reason (checked by the callers).
//
// The frontend never supplies an amount. Callers pass what was chosen (lines and
// quantities); this module returns what is refundable.
// ==========================================

const toPaise = (value) => Math.round(Number(value || 0) * 100);
const rupees = (paise) => Math.round(paise) / 100;

const refundError = (message, code = "REFUND_CALC", statusCode = 409) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

// Splits `total` whole paise over `weights` so the parts add up exactly.
const largestRemainder = (total, weights) => {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (let i = 0; left > 0 && i < order.length; i += 1, left -= 1) parts[order[i].index] += 1;
  return parts;
};

// What each order line contributed, in paise.
const allocate = (order, lines) => {
  const gross = lines.map((line) => toPaise(line.unit_price) * Number(line.quantity));
  const discounts = largestRemainder(toPaise(order.discount_amount), gross);
  const taxes = largestRemainder(toPaise(order.tax_amount), gross);

  return lines.map((line, index) => ({
    orderItemId: String(line.id),
    name: line.product_name || line.name || "",
    quantity: Number(line.quantity),
    grossPaise: gross[index],
    discountPaise: discounts[index],
    taxPaise: taxes[index],
    totalPaise: gross[index] - discounts[index] + taxes[index],
  }));
};

// Cumulative price of the first k units of a line component.
const cum = (component, quantity, k) => Math.round((component * k) / quantity);

// The part of one line covered by units offset+1 .. offset+k.
const priceUnits = (allocated, offset, k) => {
  const { quantity } = allocated;
  const part = (component) => cum(component, quantity, offset + k) - cum(component, quantity, offset);
  const grossPaise = part(allocated.grossPaise);
  const discountPaise = part(allocated.discountPaise);
  const taxPaise = part(allocated.taxPaise);
  return { grossPaise, discountPaise, taxPaise, refundPaise: grossPaise - discountPaise + taxPaise };
};

// picks: [{ orderItemId, quantity, offset }]   offset = units of that line already
//        cancelled or returned by earlier actions
const computeRefund = ({
  order,
  lines,
  picks,
  includeShipping = false,
  deductionPaise = 0,
  alreadyRefundedPaise = 0,
}) => {
  const allocated = allocate(order, lines);
  const byId = new Map(allocated.map((line) => [line.orderItemId, line]));

  if (!Array.isArray(picks) || picks.length === 0) {
    throw refundError("Choose at least one item.", "NO_ITEMS", 400);
  }

  const seen = new Set();
  const broken = [];
  for (const pick of picks) {
    const line = byId.get(String(pick.orderItemId));
    if (!line) throw refundError("One of the chosen items is not part of this order.", "UNKNOWN_ITEM", 400);
    if (seen.has(line.orderItemId)) throw refundError("The same item was chosen twice.", "DUPLICATE_ITEM", 400);
    seen.add(line.orderItemId);

    const quantity = Number(pick.quantity);
    const offset = Number(pick.offset || 0);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw refundError("Each item needs a quantity of 1 or more.", "BAD_QUANTITY", 400);
    }
    if (!Number.isInteger(offset) || offset < 0 || offset + quantity > line.quantity) {
      throw refundError(
        `Only ${Math.max(line.quantity - offset, 0)} of ${line.name || "this item"} can still be selected.`,
        "QUANTITY_UNAVAILABLE",
        409
      );
    }

    broken.push({ line, quantity, offset, ...priceUnits(line, offset, quantity) });
  }

  const goodsPaise = broken.reduce((sum, row) => sum + row.refundPaise, 0);
  const shippingPaise = includeShipping ? toPaise(order.shipping_amount) : 0;
  const calculatedPaise = goodsPaise + shippingPaise;

  const deduction = Math.round(Number(deductionPaise) || 0);
  if (deduction < 0 || deduction > calculatedPaise) {
    throw refundError("The deduction cannot be negative or more than the refund.", "BAD_DEDUCTION", 400);
  }
  const finalPaise = calculatedPaise - deduction;

  const paidPaise = toPaise(order.total_amount);
  const remainingBefore = paidPaise - Math.round(Number(alreadyRefundedPaise) || 0);
  if (finalPaise > remainingBefore) {
    throw refundError(
      "This refund would be more than the customer paid for the order.",
      "EXCEEDS_PAID",
      409
    );
  }

  return {
    lines: broken.map((row) => ({
      orderItemId: row.line.orderItemId,
      name: row.line.name,
      quantity: row.quantity,
      goods: rupees(row.grossPaise),
      discount: rupees(row.discountPaise),
      tax: rupees(row.taxPaise),
      refund: rupees(row.refundPaise),
      refundPaise: row.refundPaise,
    })),
    goods: rupees(goodsPaise),
    shipping: rupees(shippingPaise),
    calculated: rupees(calculatedPaise),
    deduction: rupees(deduction),
    final: rupees(finalPaise),
    goodsPaise,
    shippingPaise,
    calculatedPaise,
    deductionPaise: deduction,
    finalPaise,
    paid: rupees(paidPaise),
    remainingAfter: rupees(remainingBefore - finalPaise),
    includesShipping: Boolean(includeShipping),
  };
};

// ---- what is already committed for an order ------------------------------------

const COUNTED_REFUND = ["pending", "processing", "completed", "failed"];

const isMissingTable = (error) =>
  Boolean(error) && (error.code === "ER_NO_SUCH_TABLE" || error.errno === 1146);

// Units already taken out of each line (cancelled, or in a non-rejected return),
// the return list in creation order, and the money already promised back.
const loadCommitments = async (executor, orderId, lines) => {
  const result = {
    cancelledByLine: new Map(),
    returns: [], // { id, createdAt, status, units: Map(lineId -> qty) }
    refundedPaise: 0,
  };

  try {
    const [cancelled] = await executor.execute(
      `
        SELECT i.order_item_id, SUM(i.quantity) AS quantity
        FROM order_cancellation_items i
        INNER JOIN order_cancellations c ON c.id = i.cancellation_id
        WHERE c.order_id = ?
        GROUP BY i.order_item_id
      `,
      [orderId]
    );
    for (const row of cancelled) result.cancelledByLine.set(String(row.order_item_id), Number(row.quantity));

    const [cancelRefunds] = await executor.execute(
      `SELECT refund_amount FROM order_cancellations
       WHERE order_id = ? AND refund_status IN (${COUNTED_REFUND.map(() => "?").join(", ")})`,
      [orderId, ...COUNTED_REFUND]
    );
    for (const row of cancelRefunds) result.refundedPaise += toPaise(row.refund_amount);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }

  try {
    const [returns] = await executor.execute(
      `SELECT id, status, refund_status, refund_amount, created_at
       FROM return_requests WHERE order_id = ? AND status <> 'Rejected'
       ORDER BY created_at ASC, id ASC`,
      [orderId]
    );
    if (returns.length > 0) {
      const marks = returns.map(() => "?").join(", ");
      const [rows] = await executor.execute(
        `SELECT return_id, order_item_id, quantity FROM return_request_items WHERE return_id IN (${marks})`,
        returns.map((r) => r.id)
      );
      const byReturn = new Map();
      for (const row of rows) {
        if (!byReturn.has(row.return_id)) byReturn.set(row.return_id, new Map());
        byReturn.get(row.return_id).set(String(row.order_item_id), Number(row.quantity));
      }
      for (const ret of returns) {
        // A return saved before item selection existed meant "everything".
        const units =
          byReturn.get(ret.id) ||
          new Map((lines || []).map((line) => [String(line.id), Number(line.quantity)]));
        result.returns.push({ id: ret.id, createdAt: ret.created_at, status: ret.status, units });
        if (COUNTED_REFUND.includes(ret.refund_status)) result.refundedPaise += toPaise(ret.refund_amount);
      }
    }
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }

  return result;
};

// Units of a line already taken out, optionally only by actions made BEFORE a
// given return (so a return's refund never depends on later requests).
const committedUnits = (commitments, lineId, { beforeReturnId = null, all = false } = {}) => {
  let total = commitments.cancelledByLine.get(String(lineId)) || 0;
  for (const ret of commitments.returns) {
    if (!all && beforeReturnId !== null && ret.id === beforeReturnId) break;
    if (beforeReturnId !== null && ret.id === beforeReturnId) continue;
    total += ret.units.get(String(lineId)) || 0;
  }
  return total;
};

module.exports = {
  toPaise,
  rupees,
  largestRemainder,
  allocate,
  priceUnits,
  computeRefund,
  loadCommitments,
  committedUnits,
  refundError,
};
