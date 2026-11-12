// Every customer e-mail, in KOVENIK's voice. Each template takes a plain data object and returns
// { subject, text, html }. Missing optional data is skipped, never printed as "undefined".
//
// Links only point at real storefront routes (see layout.js `link`).

const { renderEmail, blocks, link, money, formatDate } = require("./layout");

const hello = (d) => `Hi ${d.name || "there"},`;
const viewOrder = (d) => ({ label: "View your order", url: link.order(d.orderId) });

const build = (subject, content) => ({ subject, ...renderEmail(content) });

const TEMPLATES = {
  // ---------------- account ----------------
  account_otp: (d) => {
    const purposes = {
      email_verification: {
        heading: "Verify your email",
        intro: "Use this code to confirm your email address and finish creating your KOVENIK account.",
      },
      login: {
        heading: "Your sign-in code",
        intro: "Use this code to sign in to your KOVENIK account.",
      },
      password_reset: {
        heading: "Reset your password",
        intro: "Use this code to reset your KOVENIK password.",
      },
    };
    const p = purposes[d.purpose] || { heading: "Your verification code", intro: "Use this code to continue on KOVENIK." };
    return build("Your KOVENIK verification code", {
      preheader: "Your one-time KOVENIK code. It expires in 10 minutes.",
      heading: p.heading,
      intro: p.intro,
      blocks: [
        blocks.code(d.code),
        blocks.note("This code expires in 10 minutes. Never share it with anyone, KOVENIK will never ask for it."),
      ],
      outro: "If you did not ask for this, you can safely ignore this email.",
    });
  },

  welcome: (d) =>
    build(`Welcome to KOVENIK${d.name ? ", " + d.name : ""}`, {
      preheader: "Your KOVENIK account is ready.",
      heading: "Welcome to KOVENIK",
      intro: `${hello(d)} your account is ready. Premium streetwear, made to be worn hard.`,
      cta: { label: "Shop now", url: link.shop() },
      outro: "Join KOVENIK Member for member pricing on eligible pieces and free shipping, all year.",
    }),

  password_changed: (d) =>
    build("Your KOVENIK password was changed", {
      preheader: "Your password was just changed.",
      heading: "Password changed",
      intro: `${hello(d)} the password for your KOVENIK account was just changed.`,
      blocks: [
        blocks.details([["When", formatDate(d.changedAt || new Date(), true)]]),
        blocks.note("If this was not you, contact support right away so we can secure your account."),
      ],
      cta: { label: "Contact support", url: link.contact() },
    }),

  support_received: (d) =>
    build("We got your message", {
      preheader: "Your message has reached KOVENIK support.",
      heading: "We got your message",
      intro: `${hello(d)} thanks for reaching out. Your message has reached our team and we will reply by email.`,
      blocks: [blocks.details([["Subject", d.subject], ["Order", d.orderNumber]])],
      cta: { label: "Browse FAQs", url: link.faqs() },
    }),

  // ---------------- orders ----------------
  order_confirmation: (d) => {
    const online = d.paymentMethod === "online";
    const address = [d.shipName, d.shipPhone, d.shipAddress, [d.shipCity, d.shipState].filter(Boolean).join(", "), d.shipPincode]
      .filter(Boolean)
      .join(", ");
    return build(`Your KOVENIK order ${d.orderNumber} is confirmed`, {
      preheader: `Order ${d.orderNumber} is confirmed.`,
      heading: "Your order is confirmed",
      intro: `${hello(d)} we're getting your KOVENIK pieces ready.`,
      blocks: [
        blocks.details([
          ["Order", d.orderNumber],
          ["Placed", formatDate(d.placedAt, true)],
          ["Payment", online ? "Paid online" : "Cash on delivery"],
        ]),
        blocks.summary(d),
        blocks.details([["Delivering to", address]]),
        blocks.note(online ? "" : `Please keep ${money(d.total)} ready when your order arrives.`),
      ],
      cta: viewOrder(d),
      outro: "We'll email you again as soon as it ships.",
    });
  },

  order_shipped: (d) =>
    build(`Your KOVENIK order ${d.orderNumber} is on its way`, {
      preheader: `Order ${d.orderNumber} has shipped.`,
      heading: "Your order is on its way",
      intro: `${hello(d)} your KOVENIK order has shipped.`,
      blocks: [blocks.details([["Order", d.orderNumber], ["Courier", d.carrier], ["Tracking", d.trackingNumber]])],
      cta: { label: "Track your order", url: link.order(d.orderId) },
    }),

  order_delivered: (d) =>
    build(`Your KOVENIK order ${d.orderNumber} was delivered`, {
      preheader: `Order ${d.orderNumber} has been delivered.`,
      heading: "Delivered",
      intro: `${hello(d)} your KOVENIK order has been delivered. We hope you love it.`,
      blocks: [
        blocks.details([["Order", d.orderNumber]]),
        blocks.note("Need to send something back? You can request a return from your order page within the return window."),
      ],
      cta: viewOrder(d),
    }),

  cancellation_confirmed: (d) =>
    build(`Your KOVENIK order ${d.orderNumber} was cancelled`, {
      preheader: `Cancellation for order ${d.orderNumber}.`,
      heading: d.whole === false ? "Items cancelled" : "Order cancelled",
      intro:
        `${hello(d)} ` +
        (d.whole === false ? `the items below were cancelled from order ${d.orderNumber}.` : `your order ${d.orderNumber} has been cancelled.`),
      blocks: [
        blocks.details([["Items", d.items], ["Reason", d.reason]]),
        blocks.note(
          d.refundAmount > 0
            ? `A refund of ${money(d.refundAmount)} will go to your original payment method. We'll email you when it is complete.`
            : "You were not charged for the cancelled items, so no refund is needed."
        ),
      ],
      cta: viewOrder(d),
    }),

  // ---------------- payments ----------------
  payment_failed: (d) =>
    build(`Payment unsuccessful for order ${d.orderNumber}`, {
      preheader: "Your payment did not go through.",
      heading: "Payment didn't go through",
      intro: `${hello(d)} we could not complete your payment, so the order was not placed. You have not been charged, or any amount debited will be returned by your bank.`,
      blocks: [blocks.details([["Order", d.orderNumber], ["Amount", d.amount != null ? money(d.amount) : ""]])],
      cta: { label: "Return to your cart", url: link.cart() },
      outro: "Your items are still in your cart whenever you're ready.",
    }),

  // ---------------- refunds ----------------
  refund_initiated: (d) =>
    build(`Your refund for order ${d.orderNumber} has started`, {
      preheader: `Refund of ${money(d.amount)} started.`,
      heading: "Refund started",
      intro: `${hello(d)} we've started your refund.`,
      blocks: [
        blocks.details([["Order", d.orderNumber], ["Refund amount", money(d.amount)]]),
        blocks.note("Banks usually take 5 to 7 working days to show a refund."),
      ],
      cta: viewOrder(d),
    }),

  refund_completed: (d) =>
    build(`Your refund for order ${d.orderNumber} is complete`, {
      preheader: `Refund of ${money(d.amount)} processed.`,
      heading: "Refund complete",
      intro: `${hello(d)} your refund has been processed.`,
      blocks: [blocks.details([["Order", d.orderNumber], ["Refund amount", money(d.amount)], ["Method", d.method], ["Reference", d.reference]])],
      cta: viewOrder(d),
    }),

  refund_failed: (d) =>
    build(`We are fixing your refund for order ${d.orderNumber}`, {
      preheader: "Your refund needs one more try.",
      heading: "We're fixing your refund",
      intro: `${hello(d)} your refund didn't go through on the first try. Our team has been told and will retry it. You don't need to do anything.`,
      blocks: [blocks.details([["Order", d.orderNumber], ["Refund amount", money(d.amount)]])],
      cta: { label: "Contact support", url: link.contact() },
    }),

  // ---------------- returns ----------------
  return_submitted: (d) =>
    build(`We received your return request for order ${d.orderNumber}`, {
      preheader: `Return request for order ${d.orderNumber} received.`,
      heading: "Return request received",
      intro: `${hello(d)} we have your return request and will email you our decision.`,
      blocks: [blocks.details([["Order", d.orderNumber], ["Items", d.items]])],
      cta: viewOrder(d),
    }),

  return_approved: (d) =>
    build(`Your return for order ${d.orderNumber} is approved`, {
      preheader: "Your return is approved.",
      heading: "Return approved",
      intro: `${hello(d)} good news, your return is approved.`,
      blocks: [
        blocks.details([["Order", d.orderNumber], ["Items", d.items]]),
        blocks.note(
          'Pack the item(s) in original condition with tags and send them back. Then open your order page and tap "I have sent the items" (you can add a tracking number).'
        ),
      ],
      cta: viewOrder(d),
    }),

  return_rejected: (d) =>
    build(`About your return request for order ${d.orderNumber}`, {
      preheader: "An update on your return request.",
      heading: "Return not accepted",
      intro: `${hello(d)} we're sorry, we couldn't accept this return request.`,
      blocks: [blocks.details([["Order", d.orderNumber], ["Reason", d.reason]])],
      cta: { label: "Contact support", url: link.contact() },
    }),

  return_received: (d) =>
    build(`We received your returned item(s) for order ${d.orderNumber}`, {
      preheader: "Your return has reached us.",
      heading: "Return received",
      intro: `${hello(d)} your returned item(s) have reached us. We're checking them now and will update you.`,
      blocks: [blocks.details([["Order", d.orderNumber]])],
      cta: viewOrder(d),
    }),

  return_inspected: (d) =>
    build(`We finished checking your return for order ${d.orderNumber}`, {
      preheader: "Your return check is complete.",
      heading: "Return checked",
      intro:
        `${hello(d)} we finished checking your returned item(s). ` +
        (d.refundable ? "We will now process your refund." : "Unfortunately none of the items qualify for a refund."),
      blocks: [
        blocks.details([["Order", d.orderNumber], ["Note from our team", d.note]]),
        blocks.note(d.timeline ? `Refund timeline: ${d.timeline}.` : ""),
      ],
      cta: viewOrder(d),
    }),

  return_refund_processing: (d) =>
    build(`Your return refund for order ${d.orderNumber} is being processed`, {
      preheader: `Return refund of ${money(d.amount)} in progress.`,
      heading: "Refund in progress",
      intro: `${hello(d)} your return refund is approved and being processed. We'll email you when it is complete.`,
      blocks: [
        blocks.details([
          ["Order", d.orderNumber],
          ["Refund amount", money(d.amount)],
          ["Refund to", d.method],
          ["Shipping refunded", Number(d.shipping) > 0 ? money(d.shipping) : ""],
          ["COD handling fee refunded", Number(d.codFee) > 0 ? money(d.codFee) : ""],
          ["Expected by", d.estimatedBy ? formatDate(d.estimatedBy) : ""],
        ]),
        blocks.note(d.timeline ? `Refund timeline: ${d.timeline}.` : ""),
      ],
      cta: viewOrder(d),
    }),

  return_refund_completed: (d) =>
    build(`Your return refund for order ${d.orderNumber} is complete`, {
      preheader: `Return refund of ${money(d.amount)} complete.`,
      heading: "Return refund complete",
      intro: `${hello(d)} your return refund is complete.`,
      blocks: [
        blocks.details([
          ["Order", d.orderNumber],
          ["Refund amount", money(d.amount)],
          ["Shipping refunded", Number(d.shipping) > 0 ? money(d.shipping) : ""],
          ["COD handling fee refunded", Number(d.codFee) > 0 ? money(d.codFee) : ""],
          ["Method", d.method],
          ["Reference (UTR)", d.reference],
        ]),
      ],
      cta: viewOrder(d),
    }),

  return_refund_failed: (d) =>
    build(`We are fixing your return refund for order ${d.orderNumber}`, {
      preheader: "Your return refund needs one more try.",
      heading: "We're fixing your refund",
      intro: `${hello(d)} your return refund didn't go through on the first try. Our team has been told and will retry it. You don't need to do anything.`,
      blocks: [blocks.details([["Order", d.orderNumber], ["Refund amount", money(d.amount)]])],
      cta: { label: "Contact support", url: link.contact() },
    }),

  // ---------------- membership ----------------
  membership_activated: (d) =>
    build("Welcome to KOVENIK Member", {
      preheader: "Your KOVENIK membership is active.",
      heading: "You're a KOVENIK Member",
      intro: `${hello(d)} your membership is active. Enjoy member pricing on eligible pieces and free shipping.`,
      blocks: [
        blocks.details([
          ["Plan", d.planName || "KOVENIK MEMBER"],
          ["Paid", d.amount != null ? money(d.amount) : ""],
          ["Valid from", formatDate(d.startDate)],
          ["Valid until", formatDate(d.endDate)],
        ]),
      ],
      cta: { label: "View membership", url: link.membership() },
    }),

  membership_renewed: (d) =>
    build("Your KOVENIK membership is renewed", {
      preheader: "Your renewal is confirmed.",
      heading: "Membership renewed",
      intro: `${hello(d)} your renewal is confirmed. It starts right after your current term ends, so nothing you already paid for is lost.`,
      blocks: [
        blocks.details([
          ["Plan", d.planName || "KOVENIK MEMBER"],
          ["Paid", d.amount != null ? money(d.amount) : ""],
          ["Renewal starts", formatDate(d.startDate)],
          ["Valid until", formatDate(d.endDate)],
        ]),
      ],
      cta: { label: "View membership", url: link.membership() },
    }),

  membership_expiring: (d) =>
    build("Your KOVENIK membership ends soon", {
      preheader: `Your membership ends on ${formatDate(d.endDate)}.`,
      heading: "Your membership ends soon",
      intro: `${hello(d)} your KOVENIK membership ends on ${formatDate(d.endDate)}. Renew to keep your member pricing and free shipping.`,
      blocks: [blocks.details([["Plan", d.planName || "KOVENIK MEMBER"], ["Ends", formatDate(d.endDate)]])],
      cta: { label: "View membership", url: link.membership() },
    }),

  membership_expired: (d) =>
    build("Your KOVENIK membership has ended", {
      preheader: "Your membership has expired.",
      heading: "Your membership has ended",
      intro: `${hello(d)} your KOVENIK membership ended on ${formatDate(d.endDate)}. You can rejoin any time.`,
      cta: { label: "View membership", url: link.membership() },
    }),

  membership_payment_failed: (d) =>
    build("Your KOVENIK membership payment didn't go through", {
      preheader: "Your membership payment was not completed.",
      heading: "Payment didn't go through",
      intro: `${hello(d)} we could not complete your membership payment, so it was not activated. If any amount was debited, your bank will return it.`,
      blocks: [blocks.details([["Plan", d.planName || "KOVENIK MEMBER"], ["Amount", d.amount != null ? money(d.amount) : ""]])],
      cta: { label: "Try again", url: link.membership() },
    }),
};

// A missing order number must never print as "undefined" (it cannot happen for a real order, but
// a template must not break if it does).
for (const name of Object.keys(TEMPLATES)) {
  const render = TEMPLATES[name];
  TEMPLATES[name] = (data = {}) => render({ orderNumber: "", ...data });
}

module.exports = { TEMPLATES };
