// Homepage banners: admin CRUD + public listing. Drives the REAL app (router,
// auth, service) over HTTP with an in-memory stand-in for MySQL and a stubbed
// Cloudinary; nothing touches a real database or image host.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "test-secret-not-used-anywhere-else";
delete process.env.CORS_ORIGINS;

const root = path.join(__dirname, "..");
const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();
const ids = { customer: "00000000-0000-4000-8000-000000000001", admin: "00000000-0000-4000-8000-000000000002" };

const db = {};
const cloud = { uploads: [], destroyed: [], failUpload: false };
let migrated = true;

// The write limiter counts per user, so each test signs in as its own admin.
let adminSeq = 100;
const reset = () => {
  adminSeq += 1;
  ids.admin = `00000000-0000-4000-8000-${String(adminSeq).padStart(12, "0")}`;
  db.accounts = [
    { id: ids.customer, email: "c@example.com", role: "customer", is_active: 1 },
    { id: ids.admin, email: "a@example.com", role: "admin", is_active: 1 },
  ];
  db.banners = [];
  db.audit = [];
  cloud.uploads = [];
  cloud.destroyed = [];
  cloud.failUpload = false;
  migrated = true;
};

// Mirrors the UTC window / flag columns the SQL computes.
const view = (b) => {
  const now = Date.now();
  const at = (s) => (s ? Date.parse(`${s.replace(" ", "T")}Z`) : null);
  const z = (s) => (s ? `${s.replace(" ", "T")}Z` : null);
  return {
    ...b,
    start_at: z(b.start_at),
    end_at: z(b.end_at),
    created_at: "2026-10-31T00:00:00Z",
    is_upcoming: at(b.start_at) !== null && at(b.start_at) > now ? 1 : 0,
    is_expired: at(b.end_at) !== null && at(b.end_at) <= now ? 1 : 0,
  };
};
const sorted = (rows) => [...rows].sort((a, b) => a.sort_order - b.sort_order || a.seq - b.seq);

const run = async (sql, p = []) => {
  const t = norm(sql);
  if (t.startsWith("select revoked_before from session_revocations")) return [[]];
  if (t.startsWith("select id, email, role, is_active from profiles where id = ? limit 1")) {
    return [db.accounts.filter((a) => a.id === p[0])];
  }
  if (t.startsWith("insert ignore into audit_logs")) {
    db.audit.push({ action: p[4], resource_id: p[6] });
    return [{ affectedRows: 1 }];
  }

  if (t.includes("editorial_banners")) {
    if (!migrated && (t.includes("mobile_image_url") || t.includes("sort_order"))) {
      const e = new Error("Unknown column");
      e.errno = 1054;
      e.code = "ER_BAD_FIELD_ERROR";
      throw e;
    }
    if (t.startsWith("select count(*) as total")) {
      return [[{ total: db.banners.length, top: Math.max(-1, ...db.banners.map((b) => b.sort_order)) }]];
    }
    if (t.startsWith("select count(*) as used")) {
      return [[{ used: db.banners.filter((b) => b.image_url === p[0] || b.mobile_image_url === p[1]).length }]];
    }
    if (t.startsWith("select") && t.includes("where active = 1")) {
      return [sorted(db.banners).map(view).filter((b) => b.active && !b.is_upcoming && !b.is_expired)];
    }
    if (t.startsWith("select") && t.includes("where id = ?")) return [db.banners.filter((b) => b.id === p[0]).map(view)];
    if (t.startsWith("select")) return [sorted(db.banners).map(view)];
    if (t.startsWith("insert into")) {
      db.banners.push({
        seq: db.banners.length,
        id: p[0], name: p[1], image_url: p[2], mobile_image_url: p[3], link_url: p[4],
        active: p[5], sort_order: p[6], start_at: p[7], end_at: p[8],
      });
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("update editorial_banners set active")) {
      db.banners.find((b) => b.id === p[1]).active = p[0];
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("update editorial_banners")) {
      Object.assign(db.banners.find((b) => b.id === p[8]), {
        name: p[0], image_url: p[1], mobile_image_url: p[2], link_url: p[3], active: p[4],
        sort_order: p[5], start_at: p[6], end_at: p[7],
      });
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("delete from editorial_banners")) {
      db.banners = db.banners.filter((b) => b.id !== p[0]);
      return [{ affectedRows: 1 }];
    }
  }
  throw new Error(`banner.test fake DB: unhandled SQL: ${t}`);
};

const pool = { execute: run, query: run };
const sqlPath = require.resolve(path.join(root, "config", "sql.js"));
require.cache[sqlPath] = {
  id: sqlPath,
  filename: sqlPath,
  loaded: true,
  exports: { poolPromise: Promise.resolve(pool), testDatabaseConnection: async () => {} },
};

const cloudinary = require(path.join(root, "config", "cloudinary.js"));
let uploadSeq = 0;
cloudinary.uploader.upload_stream = (options, done) => ({
  end: () => {
    if (cloud.failUpload) return done(new Error("cloudinary down"));
    uploadSeq += 1;
    const id = `img${uploadSeq}`;
    cloud.uploads.push(options.folder);
    done(null, { secure_url: `https://res.cloudinary.com/demo/image/upload/v1/ardenby/banners/${id}.jpg` });
  },
});
cloudinary.uploader.destroy = async (publicId) => {
  cloud.destroyed.push(publicId);
  return { result: "ok" };
};

const app = require(path.join(root, "app.js"));
let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(reset);

const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

const form = (fields = {}, files = {}) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  for (const [k, v] of Object.entries(files)) {
    body.append(k, new Blob([v.bytes || PNG], { type: v.type || "image/png" }), v.name || "banner.png");
  }
  return body;
};

const call = async (method, url, { as, body, json } = {}) => {
  const headers = as ? { Authorization: `Bearer ${token(as)}` } : {};
  if (json) headers["Content-Type"] = "application/json";
  const response = await fetch(`${base}${url}`, { method, headers, body: json ? JSON.stringify(json) : body });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const create = (fields = {}, files = { image: {} }, as = ids.admin) =>
  call("POST", "/api/admin/banners", { as, body: form({ name: "New collection", ...fields }, files) });

const day = 86400000;
const inFuture = (ms) => new Date(Date.now() + ms).toISOString();

// ---------------------------------------------------------------- authorization

test("admin banner routes need a login and an admin role", async () => {
  assert.equal((await call("GET", "/api/admin/banners")).status, 401);
  assert.equal((await call("GET", "/api/admin/banners", { as: ids.customer })).status, 403);
  assert.equal((await create({}, { image: {} }, ids.customer)).status, 403);
  assert.equal((await call("DELETE", "/api/admin/banners/x", { as: ids.customer })).status, 403);
  assert.equal((await call("PATCH", "/api/admin/banners/x/active", { as: ids.customer, json: { active: false } })).status, 403);
  assert.equal(db.banners.length, 0);
});

// ---------------------------------------------------------------- create

test("create stores the banner, uploads to the banners folder and is audited", async () => {
  const res = await create({ linkUrl: "/shop?category=epic-thread", sortOrder: "3" });
  assert.equal(res.status, 201);
  assert.equal(res.json.banner.name, "New collection");
  assert.equal(res.json.banner.linkUrl, "/shop?category=epic-thread");
  assert.equal(res.json.banner.sortOrder, 3);
  assert.equal(res.json.banner.active, true);
  assert.equal(res.json.banner.status, "live");
  assert.deepEqual(cloud.uploads, ["ardenby/banners"]);
  assert.deepEqual(db.audit.map((a) => a.action), ["banner.create"]);
});

test("create validates title, image, link, dates and order", async () => {
  assert.equal((await create({ name: "  " })).status, 400);
  assert.equal((await create({}, {})).status, 400, "image is required");
  assert.equal((await create({ linkUrl: "javascript:alert(1)" })).status, 400);
  assert.equal((await create({ linkUrl: "//evil.example" })).status, 400);
  assert.equal((await create({ linkUrl: "ftp://x.example/a" })).status, 400);
  assert.equal((await create({ startAt: "not a date" })).status, 400);
  assert.equal((await create({ startAt: "2030-12-01T10:00:00Z", endAt: "2030-11-01T10:00:00Z" })).status, 400);
  assert.equal((await create({ sortOrder: "-1" })).status, 400);
  assert.equal((await create({ sortOrder: "1.5" })).status, 400);
  assert.equal((await create({ active: "maybe" })).status, 400);
  assert.equal(db.banners.length, 0);
  assert.equal(cloud.uploads.length, 0, "nothing is uploaded for an invalid request");
});

test("create refuses non-images and disguised files", async () => {
  const wrongType = await create({}, { image: { type: "text/html", name: "x.html" } });
  assert.equal(wrongType.status, 400);
  const fake = await create({}, { image: { bytes: Buffer.from("<script>alert(1)</script>".padEnd(40, " ")) } });
  assert.equal(fake.status, 400);
  assert.equal(db.banners.length, 0);
});

test("a failed image upload creates nothing and shows a safe message", async () => {
  cloud.failUpload = true;
  const res = await create();
  assert.equal(res.status, 502);
  assert.ok(!/cloudinary/i.test(res.json.message));
  assert.equal(db.banners.length, 0);
});

test("a new banner goes to the end of the order by default", async () => {
  await create({ name: "A" });
  await create({ name: "B" });
  const list = await call("GET", "/api/admin/banners", { as: ids.admin });
  assert.deepEqual(list.json.banners.map((b) => [b.name, b.sortOrder]), [["A", 0], ["B", 1]]);
});

// ---------------------------------------------------------------- public API

test("public API returns only live banners in display order", async () => {
  await create({ name: "Third", sortOrder: "3" });
  await create({ name: "First", sortOrder: "1" });
  await create({ name: "Hidden", sortOrder: "0", active: "false" });
  await create({ name: "Future", sortOrder: "0", startAt: inFuture(day) });
  await create({ name: "Past", sortOrder: "0", endAt: inFuture(-day) });
  await create({ name: "Window", sortOrder: "2", startAt: inFuture(-day), endAt: inFuture(day) });

  const res = await call("GET", "/api/banners");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.banners.map((b) => b.name), ["First", "Window", "Third"]);
  assert.deepEqual(Object.keys(res.json.banners[0]).sort(), ["id", "imageUrl", "linkUrl", "mobileImageUrl", "name", "sortOrder"]);

  const admin = await call("GET", "/api/admin/banners", { as: ids.admin });
  const status = Object.fromEntries(admin.json.banners.map((b) => [b.name, b.status]));
  assert.equal(status.Hidden, "inactive");
  assert.equal(status.Future, "scheduled");
  assert.equal(status.Past, "expired");
  assert.equal(status.First, "live");
});

test("public API answers an empty list before the migration", async () => {
  migrated = false;
  const res = await call("GET", "/api/banners");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.banners, []);
});

test("admin list explains that the migration is pending", async () => {
  migrated = false;
  const res = await call("GET", "/api/admin/banners", { as: ids.admin });
  assert.equal(res.status, 503);
  assert.match(res.json.message, /not available yet/i);
});

// ---------------------------------------------------------------- update / toggle / delete

test("edit changes fields, keeps the image unless a new one is sent, and cleans the old image", async () => {
  const made = (await create({ name: "Old" })).json.banner;

  const renamed = await call("PUT", `/api/admin/banners/${made.id}`, {
    as: ids.admin,
    body: form({ name: "Renamed", linkUrl: "https://kovenik.example/sale", endAt: "" }),
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.banner.name, "Renamed");
  assert.equal(renamed.json.banner.imageUrl, made.imageUrl);
  assert.equal(cloud.destroyed.length, 0);

  const swapped = await call("PUT", `/api/admin/banners/${made.id}`, { as: ids.admin, body: form({}, { image: {} }) });
  assert.equal(swapped.status, 200);
  assert.notEqual(swapped.json.banner.imageUrl, made.imageUrl);
  assert.deepEqual(cloud.destroyed, [`ardenby/banners/${/banners\/(img\d+)/.exec(made.imageUrl)[1]}`]);
  assert.deepEqual(db.audit.map((a) => a.action), ["banner.create", "banner.update", "banner.update"]);
});

test("edit rejects bad input and unknown banners", async () => {
  const made = (await create()).json.banner;
  assert.equal((await call("PUT", `/api/admin/banners/${made.id}`, { as: ids.admin, body: form({ name: "" }) })).status, 400);
  assert.equal((await call("PUT", `/api/admin/banners/${made.id}`, { as: ids.admin, body: form({ linkUrl: "javascript:1" }) })).status, 400);
  assert.equal((await call("PUT", "/api/admin/banners/nope", { as: ids.admin, body: form({ name: "x" }) })).status, 404);
  assert.equal(db.banners[0].name, "New collection");
});

test("an end date before the stored start date is refused on edit", async () => {
  const made = (await create({ startAt: "2030-01-10T00:00:00Z" })).json.banner;
  const res = await call("PUT", `/api/admin/banners/${made.id}`, { as: ids.admin, body: form({ endAt: "2030-01-01T00:00:00Z" }) });
  assert.equal(res.status, 400);
});

test("activate / deactivate flips visibility on the public API", async () => {
  const made = (await create()).json.banner;
  assert.equal((await call("GET", "/api/banners")).json.banners.length, 1);

  const off = await call("PATCH", `/api/admin/banners/${made.id}/active`, { as: ids.admin, json: { active: false } });
  assert.equal(off.status, 200);
  assert.equal(off.json.banner.status, "inactive");
  assert.equal((await call("GET", "/api/banners")).json.banners.length, 0);

  const on = await call("PATCH", `/api/admin/banners/${made.id}/active`, { as: ids.admin, json: { active: true } });
  assert.equal(on.json.banner.status, "live");
  assert.equal((await call("PATCH", `/api/admin/banners/${made.id}/active`, { as: ids.admin, json: { active: "x" } })).status, 400);
  assert.equal((await call("PATCH", "/api/admin/banners/nope/active", { as: ids.admin, json: { active: true } })).status, 404);
  assert.deepEqual(db.audit.map((a) => a.action), ["banner.create", "banner.deactivate", "banner.activate"]);
});

test("delete removes only that banner and its own hosted image", async () => {
  const a = (await create({ name: "A" })).json.banner;
  const b = (await create({ name: "B" })).json.banner;

  assert.equal((await call("DELETE", `/api/admin/banners/${a.id}`, { as: ids.admin })).status, 200);
  assert.deepEqual(db.banners.map((x) => x.name), ["B"]);
  assert.equal(cloud.destroyed.length, 1);
  assert.equal((await call("DELETE", `/api/admin/banners/${a.id}`, { as: ids.admin })).status, 404);
  assert.equal(db.banners[0].id, b.id);
  assert.ok(db.audit.some((x) => x.action === "banner.delete"));
});

test("an image URL this site did not upload is never sent to Cloudinary for deletion", () => {
  const { bannerPublicId } = require(path.join(root, "services", "banner.service.js"));
  assert.equal(bannerPublicId("https://res.cloudinary.com/x/image/upload/v12/ardenby/banners/abc_1.jpg"), "ardenby/banners/abc_1");
  assert.equal(bannerPublicId("https://res.cloudinary.com/x/image/upload/f_auto/v12/ardenby/banners/abc.webp"), "ardenby/banners/abc");
  assert.equal(bannerPublicId("https://res.cloudinary.com/x/image/upload/v12/ardenby/products/abc.jpg"), null);
  assert.equal(bannerPublicId("https://example.com/ardenby/banners/abc.jpg"), null);
  assert.equal(bannerPublicId(null), null);
});
