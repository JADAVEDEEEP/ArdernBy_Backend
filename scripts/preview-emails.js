// Renders every KOVENIK e-mail template to HTML + text files so the design can be reviewed in a
// browser. Sends NOTHING: it never touches the mail transport or the database.
//
//   node scripts/preview-emails.js [output-folder]      (default: ./email-previews)
const fs = require("fs");
const path = require("path");
const { TEMPLATES } = require("../services/email/templates");
const { SAMPLES } = require("../services/email/samples");

const out = path.resolve(process.argv[2] || "email-previews");
fs.mkdirSync(out, { recursive: true });

const names = Object.keys(TEMPLATES);
const rows = [];
for (const name of names) {
  const mail = TEMPLATES[name](SAMPLES[name] || {});
  fs.writeFileSync(path.join(out, `${name}.html`), mail.html);
  fs.writeFileSync(path.join(out, `${name}.txt`), `Subject: ${mail.subject}\n\n${mail.text}\n`);
  rows.push(`<li><a href="${name}.html">${name}</a> - ${mail.subject.replace(/</g, "&lt;")} (<a href="${name}.txt">text</a>)</li>`);
}
fs.writeFileSync(
  path.join(out, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>KOVENIK e-mail previews</title><body style="font-family:Arial;max-width:760px;margin:32px auto"><h1>KOVENIK e-mail previews</h1><ul>${rows.join("")}</ul></body>`
);
console.log(`Wrote ${names.length} templates to ${out}`);
