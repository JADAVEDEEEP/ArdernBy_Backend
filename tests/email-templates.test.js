const test = require("node:test");
const assert = require("node:assert/strict");

const { TEMPLATES } = require("../services/email/templates");
const { SAMPLES } = require("../services/email/samples");
const { link, esc } = require("../services/email/layout");

const names = Object.keys(TEMPLATES);

// Real storefront routes (ArdenBy/app). An e-mail may only link to these.
const REAL_ROUTES = [
  /^\/$/, /^\/orders(\/[^/]+)?$/, /^\/membership$/, /^\/profile$/, /^\/shop$/, /^\/cart$/,
  /^\/contact$/, /^\/faqs$/, /^\/shipping$/, /^\/returns$/, /^\/privacy$/, /^\/terms$/,
];

test("every template has a sample, an HTML body and a text body", () => {
  for (const name of names) {
    assert.ok(SAMPLES[name], `${name} has no sample data`);
    const mail = TEMPLATES[name](SAMPLES[name]);
    assert.ok(mail.subject && mail.html && mail.text, `${name} is incomplete`);
    assert.match(mail.html, /^<!DOCTYPE html>/);
    assert.match(mail.html, /KOVENIK/);
    assert.match(mail.html, /viewport/, `${name} is not responsive`);
    assert.doesNotMatch(mail.html + mail.text + mail.subject, /ARDENBY|A R D E N B Y|undefined|NaN|\[object/, `${name} leaks a bad value`);
    assert.ok(!/<script|<link|<img/i.test(mail.html), `${name} uses a tag email clients block`);
  }
});

test("every template survives completely missing data", () => {
  for (const name of names) {
    const mail = TEMPLATES[name]({});
    assert.doesNotMatch(mail.html + mail.text, /undefined|NaN|\[object/, `${name} printed a missing value`);
  }
});

test("every link points at a real storefront route", () => {
  for (const name of names) {
    const mail = TEMPLATES[name](SAMPLES[name]);
    const hrefs = [...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => !h.startsWith("mailto:"));
    assert.ok(hrefs.length > 0, `${name} has no links`);
    for (const href of hrefs) {
      const url = new URL(href);
      assert.equal(url.origin, new URL(link.home()).origin, `${name}: ${href} leaves the site`);
      assert.ok(REAL_ROUTES.some((r) => r.test(url.pathname)), `${name}: ${url.pathname} is not a real route`);
    }
  }
});

test("customer-controlled text is escaped in HTML", () => {
  const evil = '<img src=x onerror=alert(1)>"&';
  const mail = TEMPLATES.order_confirmation({
    ...SAMPLES.order_confirmation,
    name: evil,
    shipName: evil,
    lines: [{ name: evil, size: evil, color: evil, quantity: 1, unitPrice: 10 }],
  });
  assert.ok(!mail.html.includes("<img"), "raw tag survived");
  assert.ok(mail.html.includes("&lt;img"));
  assert.equal(esc("<&>\"'"), "&lt;&amp;&gt;&quot;&#39;");
});

test("order confirmation: details, totals, COD vs online, and CTA to the order", () => {
  const online = TEMPLATES.order_confirmation(SAMPLES.order_confirmation);
  assert.equal(online.subject, "Your KOVENIK order KOV-240915-1042 is confirmed");
  assert.match(online.text, /Your order is confirmed/);
  assert.match(online.text, /getting your KOVENIK pieces ready/);
  assert.match(online.text, /Total: ₹5,090\.00/);
  assert.match(online.text, /Shipping: Free/);
  assert.match(online.html, /Paid online/);
  assert.ok(online.html.includes(`/orders/${SAMPLES.order_confirmation.orderId}`));

  const cod = TEMPLATES.order_confirmation({ ...SAMPLES.order_confirmation, paymentMethod: "cod" });
  assert.match(cod.html, /Cash on delivery/);
  assert.match(cod.text, /keep ₹5,090\.00 ready/);
});

test("OTP e-mail shows the code and the right purpose", () => {
  const mail = TEMPLATES.account_otp({ code: "123456", purpose: "password_reset" });
  assert.match(mail.html, /123456/);
  assert.match(mail.text, /123456/);
  assert.match(mail.html, /Reset your password/);
  assert.match(mail.text, /Never share it/);
});

test("membership e-mails carry plan, dates and a link to /membership", () => {
  for (const name of ["membership_activated", "membership_renewed", "membership_expiring", "membership_expired", "membership_payment_failed"]) {
    const mail = TEMPLATES[name](SAMPLES[name]);
    assert.ok(mail.html.includes("/membership"), `${name} has no membership link`);
  }
  const a = TEMPLATES.membership_activated(SAMPLES.membership_activated);
  assert.match(a.text, /KOVENIK MEMBER/);
  assert.match(a.text, /₹199\.00/);
  assert.match(a.text, /Valid until: 9 Nov 2027/);
});

test("shipped e-mail tolerates missing tracking details", () => {
  const mail = TEMPLATES.order_shipped({ name: "Asha", orderNumber: "K1", orderId: "abc" });
  assert.doesNotMatch(mail.text, /Tracking|Courier/);
  assert.match(mail.html, /Track your order/);
});

test("footer carries support and policy links", () => {
  const mail = TEMPLATES.order_delivered(SAMPLES.order_delivered);
  for (const route of ["/contact", "/shipping", "/returns", "/faqs", "/privacy", "/terms"]) {
    assert.ok(mail.html.includes(route), `footer misses ${route}`);
  }
});
