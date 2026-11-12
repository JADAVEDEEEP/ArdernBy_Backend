// AI product photography via Google Gemini (GEMINI_API_KEY) or OpenAI gpt-image-1 (OPENAI_API_KEY), stored in the SAME place and format as existing product
// images (Cloudinary folder ardenby/products, plain URL in product_images.image_url). Shared by
// scripts/generate-product-images.js and the /api/admin/images endpoints.
//
// Keys are read from the environment (never hardcoded). OpenAI is used if its key is set, otherwise Gemini. Nothing here writes a DB column that does not
// already exist; "which images are AI" is recorded in scripts/image-log.json.
const fs = require("fs");
const path = require("path");
const cloudinary = require("../config/cloudinary");
const { NEW_PRODUCTS, slugify } = require("../scripts/catalogue-data");

const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const LOG_FILE = path.join(__dirname, "..", "scripts", "image-log.json");

const SHOTS = ["front", "back", "detail", "model"];
const SHOT_LABEL = {
  front: "front view",
  back: "back view",
  detail: "close-up detail",
  model: "on-model view",
};
const MAX_TRIES = 3;

const BY_SLUG = Object.fromEntries(NEW_PRODUCTS.map((p) => [slugify(p.name), p]));

const provider = () =>
  process.env.OPENAI_API_KEY ? "openai" : process.env.GEMINI_API_KEY ? "gemini" : process.env.HF_TOKEN ? "hf" : null;
const hasKey = () => provider() !== null;
function needKey() {
  if (!hasKey()) {
    const e = new Error("No image API key: set HF_TOKEN, GEMINI_API_KEY or OPENAI_API_KEY in the backend .env");
    e.status = 503;
    throw e;
  }
}

/* ------------------------------ prompts ------------------------------ */

const STUDIO_TAIL =
  "plain off-white #F7F5F2 seamless studio background, soft diffused lighting, sharp focus, realistic fabric texture and natural folds, premium minimal streetwear brand style, no text, no logos, no watermark, 4:5 aspect ratio";

/** Facts used in prompts. Catalogue data for new products; DB fields as a fallback for any other product. */
function describe(product) {
  const c = BY_SLUG[product.slug];
  if (c) return c;
  return {
    name: product.name,
    fit: product.fit || "regular",
    color: product.color || "black",
    type: /hoodie/i.test(product.name) ? "hoodie" : /pant|jogger|jean|trouser|cargo/i.test(product.name) ? "pants" : "t-shirt",
    fabric: product.fabric || "cotton",
    gsm: null,
    print: "a plain garment with no graphic",
    coverage: product.coverage || "Front",
    collection: product.category_label || "",
  };
}

function isBottom(d) {
  return /pants|trousers|jeans|joggers|cargo/i.test(d.type);
}

function buildPrompt(product, shot, custom) {
  const d = describe(product);
  const gsm = d.gsm ? `, ${d.gsm} GSM heavyweight cotton` : "";
  const base = `${d.fit.toLowerCase()} ${d.color.toLowerCase()} ${d.type}`;
  let prompt;
  if (shot === "model") {
    const partner = isBottom(d) ? "a plain white heavyweight t-shirt" : "plain black relaxed cargo pants";
    prompt =
      `Editorial streetwear photo of a young Indian man wearing a ${base}, ${partner}, white sneakers, ` +
      `standing in a minimal concrete urban setting, overcast natural light, full body, realistic skin and fabric, ` +
      `premium fashion campaign look, the garment shows ${d.print}, no text, no logos, no brand labels, 4:5 aspect ratio`;
  } else if (shot === "back") {
    const back = d.coverage === "Back" ? d.print : "a plain back with no graphic";
    prompt = `Professional e-commerce product photo of a ${base} in ${d.fabric}${gsm}, ${back}, back view flat-lay, ${STUDIO_TAIL}`;
  } else if (shot === "detail") {
    prompt = `Professional e-commerce macro close-up of a ${base} in ${d.fabric}${gsm}: fabric texture, stitching and the neck or waistband area with a blank woven label (no text), ${d.print}, ${STUDIO_TAIL}`;
  } else {
    prompt = `Professional e-commerce product photo of a ${base} in ${d.fabric}${gsm}, ${d.print}, front flat-lay ghost-mannequin view, ${STUDIO_TAIL}`;
  }
  return custom ? `${prompt}. Additional direction: ${custom}` : prompt;
}

const needsArtwork = (d) => /graphic|illustration|puff|koi|mountain/i.test(d.print);

/* ------------------------------ OpenAI ------------------------------ */

async function openai(pathname, init) {
  needKey();
  const res = await fetch(`https://api.openai.com${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...(init.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json?.error?.message || `OpenAI request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return json;
}

/** Returns a PNG buffer. With `reference` (a PNG buffer) the artwork is used as the print. */
async function generateImage({ prompt, size = "1024x1536", reference }) {
  needKey();
  if (provider() === "gemini") return geminiImage({ prompt, size, reference });
  if (provider() === "hf") return hfImage({ prompt, size });
  if (reference) {
    const form = new FormData();
    form.append("model", IMAGE_MODEL);
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", "high");
    form.append("image", new Blob([reference], { type: "image/png" }), "artwork.png");
    const json = await openai("/v1/images/edits", { method: "POST", body: form });
    return Buffer.from(json.data[0].b64_json, "base64");
  }
  const json = await openai("/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt, size, quality: "high", n: 1 }),
  });
  return Buffer.from(json.data[0].b64_json, "base64");
}

/** Cheap vision check: does the image match the product and is it free of logos/warping? */
async function verifyImage(buffer, product, shot) {
  const d = describe(product);
  if (provider() === "gemini") return geminiVerify(buffer, d, shot);
  if (provider() === "hf") return { ok: true, issues: [] }; // no vision model on the free path: review in /admin/images
  const json = await openai("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VISION_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Check this product photo. Expected: a ${d.fit} ${d.color} ${d.type}, ${d.print}. Shot: ${SHOT_LABEL[shot]}. ` +
                `Reject if: wrong colour or garment type, any visible brand logo/label/red tab or readable text, a recognisable character, ` +
                `distorted hands or face, or a warped garment. Reply JSON: {"ok": boolean, "issues": string[]}`,
            },
            { type: "image_url", image_url: { url: `data:image/png;base64,${buffer.toString("base64")}` } },
          ],
        },
      ],
    }),
  });
  try {
    const out = JSON.parse(json.choices[0].message.content);
    return { ok: Boolean(out.ok), issues: Array.isArray(out.issues) ? out.issues : [] };
  } catch {
    return { ok: true, issues: [] };
  }
}

/* ------------------------------ Gemini ------------------------------ */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const ASPECT = { "1024x1536": "4:5", "1024x1024": "1:1", "1536x1024": "3:2" };

async function gemini(model, body) {
  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json?.error?.message || `Gemini request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return json;
}

async function geminiImage({ prompt, size, reference }) {
  const parts = [{ text: prompt }];
  if (reference) parts.push({ inline_data: { mime_type: "image/png", data: reference.toString("base64") } });
  const json = await gemini(GEMINI_IMAGE_MODEL, {
    contents: [{ parts }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: ASPECT[size] || "4:5" } },
  });
  const out = (json.candidates?.[0]?.content?.parts || []).find((p) => (p.inlineData || p.inline_data)?.data);
  if (!out) {
    const e = new Error(json.candidates?.[0]?.finishReason ? `Gemini returned no image (${json.candidates[0].finishReason})` : "Gemini returned no image");
    e.status = 502;
    throw e;
  }
  return Buffer.from((out.inlineData || out.inline_data).data, "base64");
}

async function geminiVerify(buffer, d, shot) {
  const json = await gemini(GEMINI_TEXT_MODEL, {
    contents: [
      {
        parts: [
          {
            text:
              `Check this product photo. Expected: a ${d.fit} ${d.color} ${d.type}, ${d.print}. Shot: ${SHOT_LABEL[shot]}. ` +
              `Reject if: wrong colour or garment type, any visible brand logo/label/red tab or readable text, a recognisable character, ` +
              `distorted hands or face, or a warped garment. Reply JSON: {"ok": boolean, "issues": string[]}`,
          },
          { inline_data: { mime_type: "image/png", data: buffer.toString("base64") } },
        ],
      },
    ],
    generationConfig: { responseMimeType: "application/json" },
  });
  try {
    const out = JSON.parse(json.candidates[0].content.parts[0].text);
    return { ok: Boolean(out.ok), issues: Array.isArray(out.issues) ? out.issues : [] };
  } catch {
    return { ok: true, issues: [] };
  }
}

/* ------------------------------ Hugging Face (free token) ------------------------------ */

const HF_MODEL = process.env.HF_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell";
const HF_SIZE = { "1024x1536": [832, 1040], "1024x1024": [1024, 1024], "1536x1024": [1216, 832] }; // multiples of 16

/** FLUX via the free Inference API. No reference-image support, so graphic tees are described in the prompt only. */
async function hfImage({ prompt, size }) {
  const [width, height] = HF_SIZE[size] || HF_SIZE["1024x1536"];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const res = await fetch(`https://router.huggingface.co/hf-inference/models/${HF_MODEL}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, "Content-Type": "application/json", Accept: "image/png" },
      body: JSON.stringify({ inputs: prompt, parameters: { width, height } }),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const text = await res.text().catch(() => "");
    // Model loading / busy: wait and retry.
    if ((res.status === 503 || res.status === 429) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 8000 * attempt));
      continue;
    }
    const e = new Error(`Hugging Face request failed (${res.status}): ${text.slice(0, 200)}`);
    e.status = res.status === 401 || res.status === 403 ? res.status : res.status === 429 ? 429 : 502;
    throw e;
  }
}

/* ------------------------------ storage ------------------------------ */

/** Upload to the existing ardenby/products folder; return a 4:5 (1200x1500) WebP/AVIF URL. */
async function uploadPng(buffer) {
  const result = await new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ folder: "ardenby/products", resource_type: "image" }, (err, res) => (err ? reject(err) : resolve(res)))
      .end(buffer);
  });
  const url = result.secure_url.replace("/upload/", "/upload/c_fill,g_auto,ar_4:5,w_1200,f_auto,q_auto/");
  return { url, publicId: result.public_id };
}

function readLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
  } catch {
    return { images: [], failures: [] };
  }
}
function writeLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}
function logImage(entry) {
  const log = readLog();
  log.images.push({ ...entry, at: new Date().toISOString() });
  writeLog(log);
}
function logFailure(entry) {
  const log = readLog();
  log.failures.push({ ...entry, at: new Date().toISOString() });
  writeLog(log);
}
const isAiUrl = (url) => readLog().images.some((i) => i.url === url);

/* ------------------------------ one shot ------------------------------ */

/** Generate (up to 3 tries, verified), upload and log one shot. Returns { url, prompt } or throws. */
async function generateShot(product, shot, { custom, artwork } = {}) {
  const prompt = buildPrompt(product, shot, custom);
  let lastIssues = [];
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    try {
      const png = await generateImage({ prompt, reference: artwork });
      const check = await verifyImage(png, product, shot);
      if (!check.ok && attempt < MAX_TRIES) {
        lastIssues = check.issues;
        logFailure({ slug: product.slug, shot, attempt, issues: check.issues });
        continue;
      }
      const { url, publicId } = await uploadPng(png);
      logImage({ slug: product.slug, shot, url, publicId, prompt, attempts: attempt, flagged: check.ok ? [] : check.issues, ai: true });
      return { url, prompt, flagged: check.ok ? [] : check.issues };
    } catch (err) {
      lastIssues = [err.message];
      logFailure({ slug: product.slug, shot, attempt, error: err.message });
      if (err.status === 401 || err.status === 403 || err.status === 503) throw err;
    }
  }
  const e = new Error(`Could not generate ${shot} for ${product.slug}: ${lastIssues.join("; ")}`);
  e.status = 502;
  throw e;
}

/** Artwork first for graphic products, so every shot shows the same print. */
async function generateArtwork(product) {
  const d = describe(product);
  if (!needsArtwork(d)) return undefined;
  const prompt = `Flat vector-style t-shirt graphic artwork only: ${d.print}. Isolated on a plain white background, centred, no garment, no text, no logos, no watermark.`;
  return generateImage({ prompt, size: "1024x1024" });
}

module.exports = {
  SHOTS, SHOT_LABEL, hasKey, provider, buildPrompt, describe, generateShot, generateArtwork, generateImage, uploadPng,
  isAiUrl, readLog, logImage,
};
