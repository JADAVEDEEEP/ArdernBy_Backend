// Newsletter e-mail builder: validation, sanitisation, responsive rendering, mandatory compliance footer.
// Pure functions: no database, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const email = require(path.join(__dirname, "..", "services", "newsletter-email.service"));

const saved = { pin: process.env.NEWSLETTER_POSTAL_PIN, addr: process.env.NEWSLETTER_POSTAL_ADDRESS };
test.beforeEach(() => {
  delete process.env.NEWSLETTER_POSTAL_PIN;
  delete process.env.NEWSLETTER_POSTAL_ADDRESS;
});
test.after(() => {
  if (saved.pin === undefined) delete process.env.NEWSLETTER_POSTAL_PIN; else process.env.NEWSLETTER_POSTAL_PIN = saved.pin;
  if (saved.addr === undefined) delete process.env.NEWSLETTER_POSTAL_ADDRESS; else process.env.NEWSLETTER_POSTAL_ADDRESS = saved.addr;
});

const design = (blocks, style) => ({ style, blocks });
const rejects = (input, pattern) => assert.throws(() => email.validateDesign(input), (e) => e.statusCode === 400 && e.code === "DESIGN_INVALID" && pattern.test(e.message));

test("the starter design is valid and contains no offers, prices or product claims", () => {
  const starter = email.starterDesign();
  const clean = email.validateDesign(starter);
  assert.ok(clean.blocks.length >= 3);
  const out = email.renderEmail(starter, { subject: "S", mode: "preview" });
  assert.doesNotMatch(out.html, /%\s*off|₹|discount|sale|free shipping|limited/i);
});

test("every block type validates and renders (desktop + mobile friendly table layout)", () => {
  const blocks = [
    { type: "header", tagline: "New season" },
    { type: "hero", imageUrl: "https://cdn.example.com/h.jpg", alt: "Hero", linkUrl: "https://kovenik.in/shop" },
    { type: "heading", text: "Heading", size: "xl", align: "center" },
    { type: "paragraph", text: "Line one\n\nLine two", size: "sm" },
    { type: "product_image", imageUrl: "https://cdn.example.com/p.jpg", alt: "Tee", caption: "Cap" },
    { type: "product_details", productSlug: "oxford-shirt", ctaLabel: "Shop it" },
    { type: "button", label: "Shop", url: "/shop", bg: "#111111", color: "#ffffff" },
    { type: "banner", text: "Banner text", subtext: "Sub", bg: "#C62828", color: "#FFFFFF" },
    { type: "divider" },
    { type: "footer", text: "Footer note" },
  ];
  const products = { "oxford-shirt": { slug: "oxford-shirt", name: "Oxford Shirt", price: 1299, image: "https://cdn.example.com/o.jpg" } };
  const out = email.renderEmail(design(blocks), { subject: "Hello", preheader: "Pre", products, mode: "preview" });
  assert.match(out.html, /^<!DOCTYPE html>/);
  assert.match(out.html, /name="viewport"/);
  assert.match(out.html, /max-width:600px/);
  assert.match(out.html, /@media only screen and \(max-width:620px\)/);
  assert.match(out.html, /Oxford Shirt/);
  assert.match(out.html, /₹1,299/);
  assert.match(out.html, /https:\/\/kovenik\.in\/shop|\/shop/); // relative path became an absolute storefront link
  assert.ok(!/<script|<iframe|javascript:|onerror|onclick/i.test(out.html));
  assert.match(out.text, /OXFORD SHIRT|Oxford Shirt/);
  assert.match(out.text, /Shop: https?:\/\//);
});

test("customer-controlled text is escaped, never rendered as HTML", () => {
  const evil = `<img src=x onerror=alert(1)>"&'`;
  const out = email.renderEmail(
    design([{ type: "heading", text: evil }, { type: "paragraph", text: evil }, { type: "banner", text: evil, subtext: evil }]),
    { subject: evil, preheader: evil, mode: "preview" }
  );
  assert.ok(!out.html.includes("<img src=x"), "raw tag survived");
  assert.ok(out.html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("links and images must be https; scripts, data URLs, credentials and placeholders are refused", () => {
  const bad = [
    "javascript:alert(1)", "data:text/html;base64,AAAA", "http://insecure.example.com/a.jpg", "ftp://x.example.com/a",
    "https://user:pass@example.com/a.jpg", "https://exa mple.com/a.jpg", "//evil.example.com/x", "https://example.com/{{unsubscribe_url}}",
    "https://example.com/\"onerror=\"x", "not a url",
  ];
  for (const url of bad) {
    rejects(design([{ type: "hero", imageUrl: url }]), /image|link/i);
    rejects(design([{ type: "button", label: "Go", url }]), /link/i);
  }
  assert.ok(email.validateDesign(design([{ type: "button", label: "Go", url: "https://example.com/a?b=1&c=2" }])));
});

test("colours, fonts, sizes and spacing come from fixed lists", () => {
  rejects(design([{ type: "heading", text: "H", color: "red; background:url(x)" }]), /colour/i);
  rejects(design([{ type: "heading", text: "H", color: "#GGGGGG" }]), /colour/i);
  rejects(design([{ type: "heading", text: "H", size: "99" }]), /size/i);
  rejects(design([{ type: "heading", text: "H", padding: "10px" }]), /spacing/i);
  rejects(design([{ type: "heading", text: "H", align: "justify" }]), /alignment/i);
  rejects(design([{ type: "heading", text: "H" }], { font: "Comic Sans; x:y" }), /font/i);
  rejects(design([{ type: "heading", text: "H" }], { accentColor: "url(javascript:1)" }), /colour/i);
  const ok = email.validateDesign(design([{ type: "heading", text: "H", color: "#abcdef", size: "sm", padding: "lg" }], { font: "georgia", accentColor: "#112233" }));
  assert.equal(ok.blocks[0].color, "#ABCDEF");
  assert.equal(ok.style.font, "georgia");
});

test("limits: text length, block count, unknown types, missing required fields", () => {
  rejects(design([{ type: "heading", text: "x".repeat(151) }]), /150/);
  rejects(design([{ type: "paragraph", text: "x".repeat(2001) }]), /2000/);
  rejects(design([{ type: "heading", text: "   " }]), /required/);
  rejects(design([{ type: "button", label: "Go" }]), /link/i);
  rejects(design([{ type: "script", text: "x" }]), /unknown type/i);
  rejects(design(Array.from({ length: 41 }, () => ({ type: "divider" }))), /at most 40/);
  rejects({ blocks: "nope" }, /list of content blocks/);
  rejects(design([null]), /not valid/);
  rejects(design([{ type: "product_details", productSlug: "../../etc" }]), /product/i);
});

test("unknown fields are dropped and control characters stripped", () => {
  const clean = email.validateDesign(design([{ type: "heading", text: "Hi\u0000\u0007 there", evil: "<script>", onclick: "x" }]));
  assert.equal(clean.blocks[0].text, "Hi there");
  assert.ok(!("evil" in clean.blocks[0]) && !("onclick" in clean.blocks[0]));
});

test("the compliance footer is ALWAYS present and cannot be removed by a design", () => {
  for (const blocks of [[], [{ type: "heading", text: "Only a heading" }], [{ type: "footer", text: "My own footer" }]]) {
    const out = email.renderEmail(design(blocks), { subject: "S", mode: "preview" });
    assert.match(out.html, /Unsubscribe/);
    assert.match(out.html, /subscribed to the KOVENIK newsletter/);
    assert.match(out.html, /Krishna Bunglow 1, New Ranip, Ahmedabad/);
    assert.match(out.text, /Unsubscribe:/);
    assert.match(out.text, /Krishna Bunglow 1, New Ranip, Ahmedabad/);
  }
});

test("send mode: unsubscribe placeholder is emitted and replaced per recipient", () => {
  process.env.NEWSLETTER_POSTAL_PIN = "380015";
  const out = email.renderEmail(design([{ type: "heading", text: "H" }]), { subject: "S", mode: "send" });
  assert.ok(out.html.includes(`href="${email.UNSUBSCRIBE_PLACEHOLDER}"`));
  assert.ok(out.text.includes(email.UNSUBSCRIBE_PLACEHOLDER));
  const filled = email.fillUnsubscribe(out.html, "https://kovenik.in/newsletter/unsubscribe?token=T");
  assert.ok(!filled.includes("{{"));
  assert.ok(filled.includes('href="https://kovenik.in/newsletter/unsubscribe?token=T"'));
  assert.match(out.html, /Krishna Bunglow 1, New Ranip, Ahmedabad, 380015/);
});

test("PIN code: never invented. Unset shows a visible marker in previews and BLOCKS a real send", () => {
  const preview = email.renderEmail(design([{ type: "heading", text: "H" }]), { subject: "S", mode: "preview" });
  assert.match(preview.html, /\[PIN code not set\]/);
  assert.match(preview.text, /\[PIN code not set\]/);
  assert.doesNotMatch(preview.html, /\b38\d{4}\b/);
  assert.throws(() => email.renderEmail(design([{ type: "heading", text: "H" }]), { subject: "S", mode: "send" }), (e) => e.statusCode === 409 && e.code === "POSTAL_ADDRESS_INCOMPLETE");
  process.env.NEWSLETTER_POSTAL_PIN = "12345"; // malformed -> still treated as not set
  assert.throws(() => email.renderEmail(design([]), { subject: "S", mode: "send" }), (e) => e.code === "POSTAL_ADDRESS_INCOMPLETE");
  process.env.NEWSLETTER_POSTAL_PIN = "380015";
  assert.ok(email.renderEmail(design([]), { subject: "S", mode: "send" }).html);
});

test("test mode is labelled and its unsubscribe link is inert", () => {
  const out = email.renderEmail(design([{ type: "heading", text: "H" }]), { subject: "S", mode: "test" });
  assert.match(out.html, /test email/i);
  assert.match(out.html, /href="#"/);
});

test("a product block without catalogue data renders a visible warning, never invented details", () => {
  const d = design([{ type: "product_details", productSlug: "ghost" }]);
  const out = email.renderEmail(d, { subject: "S", products: {}, mode: "preview" });
  assert.match(out.html, /was not found in the catalogue/);
  assert.deepEqual(email.missingProducts(email.validateDesign(d), {}), ["ghost"]);
  assert.deepEqual(email.productSlugs(email.validateDesign(d)), ["ghost"]);
});
