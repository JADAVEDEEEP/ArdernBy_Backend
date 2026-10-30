const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { installFakePool } = require("./helpers/fake-db");

// Minimal in-memory stand-in answering exactly the queries review.service issues.
const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();
const db = {
  products: [], profiles: [], orders: [], order_items: [], reviews: [], photos: [],
  photosTable: true,
};
let clock = 0;
const cloud = { uploaded: [], destroyed: [], fail: false };

const root = path.join(__dirname, "..");
let reviewId; // loaded after the fakes are installed

const deliveredFor = (userId, productId) =>
  db.order_items
    .filter((i) => i.product_id === productId)
    .map((i) => ({ item: i, order: db.orders.find((o) => o.id === i.order_id) }))
    .filter(({ order }) => order && order.user_id === userId && order.status === "Delivered");

const pool = {
  async execute(sql, p = []) {
    const t = norm(sql);
    if (t.startsWith("select id, slug, name from products where slug")) {
      return [db.products.filter((x) => x.slug === p[0])];
    }
    if (t.startsWith("select full_name from profiles")) {
      return [db.profiles.filter((x) => x.id === p[0])];
    }
    if (t.startsWith("select 1 from orders o")) {
      return [deliveredFor(p[0], p[1]).slice(0, 1)];
    }
    if (t.startsWith("select 1 from product_review_photos limit 1")) {
      if (!db.photosTable) throw Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE" });
      return [[]];
    }
    if (t.startsWith("select id from product_reviews where id")) {
      return [db.reviews.filter((r) => r.id === p[0])];
    }
    if (t.startsWith("insert into product_reviews")) {
      if (db.reviews.some((r) => r.id === p[0])) {
        throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY", errno: 1062 });
      }
      assert.equal(p.length, 6); // verified is a SQL constant, never a parameter
      db.reviews.push({
        id: p[0], product_id: p[1], author_name: p[2], rating: p[3],
        title: p[4], comment: p[5], verified: 1,
        review_date: "2026-10-29", created_at: ++clock,
      });
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("insert into product_review_photos")) {
      db.photos.push({ id: p[0], review_id: p[1], url: p[2], public_id: p[3], created_at: ++clock });
      return [{ affectedRows: 1 }];
    }
    if (t.includes("group by round(rating)")) {
      const g = {};
      db.reviews.filter((r) => r.product_id === p[0]).forEach((r) => {
        const s = Math.round(r.rating);
        g[s] ||= { stars: s, total: 0, sum_rating: 0 };
        g[s].total += 1;
        g[s].sum_rating += r.rating;
      });
      return [Object.values(g)];
    }
    if (t.startsWith("select id, author_name, rating") && t.includes("where id = ? and product_id")) {
      return [db.reviews.filter((r) => r.id === p[0] && r.product_id === p[1])];
    }
    if (t.startsWith("select id, author_name, rating")) {
      const m = t.match(/limit (\d+) offset (\d+)/);
      return [
        db.reviews
          .filter((r) => r.product_id === p[0])
          .sort((a, b) => b.created_at - a.created_at)
          .slice(Number(m[2]), Number(m[2]) + Number(m[1])),
      ];
    }
    if (t.startsWith("select id, review_id, url from product_review_photos")) {
      if (!db.photosTable) throw new Error("no table");
      return [db.photos.filter((x) => p.includes(x.review_id))];
    }
    if (t.startsWith("select concat('rv_'")) {
      const [productId, ...ids] = p;
      const out = [];
      db.order_items.filter((i) => i.product_id === productId).forEach((i) => {
        const o = db.orders.find((x) => x.id === i.order_id);
        if (o.status === "Delivered" && ids.includes(reviewId(o.user_id, productId))) {
          out.push({ rid: reviewId(o.user_id, productId), size: i.size, color: i.color });
        }
      });
      return [out];
    }
    if (t.startsWith("select p.full_name")) {
      const [pid1, , ...ids] = p;
      return [
        db.profiles
          .filter((x) => ids.includes(reviewId(x.id, pid1)))
          .map((x) => ({ full_name: x.full_name, rid: reviewId(x.id, pid1) })),
      ];
    }
    if (t.startsWith("update product_reviews set rating")) {
      const r = db.reviews.find((x) => x.id === p[3]);
      if (r) Object.assign(r, { rating: p[0], title: p[1], comment: p[2] });
      return [{ affectedRows: r ? 1 : 0 }];
    }
    if (t.startsWith("select public_id from product_review_photos where id")) {
      return [db.photos.filter((x) => x.id === p[0] && x.review_id === p[1])];
    }
    if (t.startsWith("select public_id from product_review_photos where review_id")) {
      if (!db.photosTable) throw new Error("no table");
      return [db.photos.filter((x) => x.review_id === p[0])];
    }
    if (t.startsWith("delete from product_review_photos where id")) {
      db.photos = db.photos.filter((x) => !(x.id === p[0] && x.review_id === p[1]));
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("delete from product_review_photos where review_id")) {
      db.photos = db.photos.filter((x) => x.review_id !== p[0]);
      return [{ affectedRows: 1 }];
    }
    if (t.startsWith("delete from product_reviews")) {
      db.reviews = db.reviews.filter((r) => !(r.id === p[0] && r.product_id === p[1]));
      return [{ affectedRows: 1 }];
    }
    throw new Error(`FakeDb: unhandled SQL: ${t}`);
  },
};
installFakePool(root, pool);

// Cloudinary stand-in.
const storagePath = require.resolve(path.join(root, "services", "storage.service"));
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true,
  exports: {
    async uploadReviewImages(files) {
      if (cloud.fail) throw new Error("cloud down");
      return files.map((f, i) => {
        const publicId = `ardenby/reviews/${f.originalname}-${i}`;
        cloud.uploaded.push(publicId);
        return { url: `https://cdn.test/${publicId}.jpg`, publicId };
      });
    },
    async deleteProductImage(id) { cloud.destroyed.push(id); },
  },
};

({ reviewId } = require("../services/review.service"));
const reviews = require("../controller/review.controller");

const call = async (handler, { user, body = {}, params = {}, query = {}, files } = {}) => {
  let status = 200;
  let payload;
  const res = {
    status(c) { status = c; return res; },
    json(d) { payload = d; return res; },
  };
  await handler({ user, body, params, query, files }, res);
  return { status, body: payload };
};

const A = { id: "userA" };
const B = { id: "userB" };
const good = { rating: 5, title: "Great fit", comment: "Fabric feels premium and fits true to size." };
const img = (name) => ({ originalname: name, buffer: Buffer.alloc(16) });

test.beforeEach(() => {
  db.products = [{ id: "p1", slug: "oxford", name: "Oxford" }, { id: "p2", slug: "tee", name: "Tee" }];
  db.profiles = [{ id: "userA", full_name: "Asha Rao" }, { id: "userB", full_name: null }];
  db.orders = []; db.order_items = []; db.reviews = []; db.photos = [];
  db.photosTable = true;
  cloud.uploaded = []; cloud.destroyed = []; cloud.fail = false;
});

const addOrder = (user_id, product_id, status, extra = {}) => {
  const id = `o${db.orders.length}`;
  db.orders.push({ id, user_id, status });
  db.order_items.push({ order_id: id, product_id, size: "M", color: "Black", ...extra });
};
const deliver = (user, product = "p1", extra) => addOrder(user.id, product, "Delivered", extra);

const post = (user, slug, body, files) => call(reviews.createReview, { user, params: { slug }, body, files });
const put = (user, slug, body, files) => call(reviews.updateReview, { user, params: { slug }, body, files });
const del = (user, slug) => call(reviews.deleteReview, { user, params: { slug } });
const list = (slug, query = {}) => call(reviews.getReviews, { params: { slug }, query });
const elig = (user, slug = "oxford") => call(reviews.getReviewEligibility, { user, params: { slug } });

// ---------- eligibility: only delivered purchases may review ----------

test("delivered purchase can review; name comes from the profile; badge data is set", async () => {
  deliver(A);
  const r = await post(A, "oxford", good);
  assert.equal(r.status, 201);
  assert.equal(db.reviews[0].author_name, "Asha Rao");
  assert.equal(db.reviews[0].product_id, "p1");
  assert.equal(db.reviews[0].verified, 1);
  assert.equal(r.body.review.verified, true);
});

test("no purchase at all is refused with 403 and nothing is saved", async () => {
  const r = await post(A, "oxford", good);
  assert.equal(r.status, 403);
  assert.equal(db.reviews.length, 0);
});

test("undelivered orders (pending, processing, shipped) cannot review", async () => {
  for (const status of ["Pending", "Confirmed", "Processing", "Packed", "Shipped"]) {
    db.orders = []; db.order_items = [];
    addOrder("userA", "p1", status);
    assert.equal((await post(A, "oxford", good)).status, 403, status);
  }
});

test("cancelled, returned and cancellation-requested orders cannot review", async () => {
  for (const status of ["Cancelled", "Returned", "Cancellation Requested"]) {
    db.orders = []; db.order_items = [];
    addOrder("userA", "p1", status);
    assert.equal((await post(A, "oxford", good)).status, 403, status);
  }
  assert.equal(db.reviews.length, 0);
});

test("a delivered order of ANOTHER product or ANOTHER customer does not qualify", async () => {
  deliver(A, "p2");
  deliver(B, "p1");
  assert.equal((await post(A, "oxford", good)).status, 403);
});

test("client-supplied verified / author / product / user fields are ignored", async () => {
  deliver(A);
  await post(A, "oxford", { ...good, verified: false, author_name: "Hacker", product_id: "p2", user_id: "userB" });
  assert.equal(db.reviews[0].author_name, "Asha Rao");
  assert.equal(db.reviews[0].product_id, "p1");
  assert.equal(db.reviews[0].id, reviewId("userA", "p1"));
});

test("falls back to a neutral name, never the email", async () => {
  deliver(B);
  await post(B, "oxford", good);
  assert.equal(db.reviews[0].author_name, "KOVENIK Customer");
});

test("listing shows each author's current profile name, from the server not the client", async () => {
  deliver(A);
  await post(A, "oxford", { ...good, authorName: "Hacker", author_name: "Hacker" });
  db.profiles.find((x) => x.id === "userA").full_name = "Asha R. Rao"; // renamed later
  let r = await list("oxford");
  assert.equal(r.body.reviews[0].authorName, "Asha R. Rao");
  db.profiles.find((x) => x.id === "userA").full_name = "";
  r = await list("oxford");
  assert.equal(r.body.reviews[0].authorName, "Asha Rao"); // stored snapshot
  db.reviews[0].author_name = "";
  r = await list("oxford");
  assert.equal(r.body.reviews[0].authorName, "KOVENIK Customer");
});

// ---------- duplicates ----------

test("second review of the same product is rejected (409), other products allowed", async () => {
  deliver(A); deliver(A, "p2");
  assert.equal((await post(A, "oxford", good)).status, 201);
  assert.equal((await post(A, "oxford", good)).status, 409);
  assert.equal(db.reviews.length, 1);
  assert.equal((await post(A, "tee", good)).status, 201);
});

test("concurrent duplicate submissions only store one", async () => {
  deliver(A);
  const results = await Promise.all([post(A, "oxford", good), post(A, "oxford", good)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(db.reviews.length, 1);
});

// ---------- validation ----------

test("rejects invalid input", async () => {
  deliver(A);
  const bad = [
    { ...good, rating: 0 }, { ...good, rating: 6 }, { ...good, rating: 4.5 },
    { ...good, rating: "abc" }, { ...good, rating: undefined },
    { ...good, title: "" }, { ...good, title: "ab" }, { ...good, title: "x".repeat(101) },
    { ...good, comment: "short" }, { ...good, comment: "y".repeat(2001) },
    { ...good, comment: 12345678901 }, { ...good, title: "   \u0000  " },
  ];
  for (const body of bad) {
    assert.equal((await post(A, "oxford", body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(db.reviews.length, 0);
});

test("unknown product is a 404 everywhere", async () => {
  assert.equal((await post(A, "nope", good)).status, 404);
  assert.equal((await put(A, "nope", good)).status, 404);
  assert.equal((await del(A, "nope")).status, 404);
  assert.equal((await list("nope")).status, 404);
});

// ---------- edit / delete: own review only ----------

test("customer can edit only their own review; others get 404 and nothing changes", async () => {
  deliver(A); deliver(B);
  await post(A, "oxford", good);
  const before = { ...db.reviews[0] };

  // B has no review: cannot touch A's, whatever they send.
  const hijack = await put(B, "oxford", { ...good, title: "Hijacked", id: before.id, review_id: before.id, user_id: "userA" });
  assert.equal(hijack.status, 404);
  assert.equal((await del(B, "oxford")).status, 404);
  assert.deepEqual(db.reviews[0], before);

  // B posts their own; editing it never alters A's.
  await post(B, "oxford", good);
  assert.equal((await put(B, "oxford", { rating: 1, title: "Changed mine", comment: "Only my own review changes." })).status, 200);
  assert.deepEqual(db.reviews.find((r) => r.id === before.id), before);

  assert.equal((await put(A, "oxford", { rating: 3, title: "Updated", comment: "Edited my own comment here." })).status, 200);
  const mine = db.reviews.find((r) => r.id === before.id);
  assert.equal(mine.rating, 3);
  assert.equal(mine.title, "Updated");
  assert.equal(mine.author_name, "Asha Rao"); // name still from profile
  assert.equal(mine.verified, 1);
});

test("editing validates input like creating", async () => {
  deliver(A);
  await post(A, "oxford", good);
  assert.equal((await put(A, "oxford", { ...good, rating: 9 })).status, 400);
  assert.equal(db.reviews[0].rating, 5);
});

test("deleting removes only the caller's review and then they can review again", async () => {
  deliver(A); deliver(B);
  await post(A, "oxford", good); await post(B, "oxford", good);
  assert.equal((await del(A, "oxford")).status, 200);
  assert.equal(db.reviews.length, 1);
  assert.equal(db.reviews[0].id, reviewId("userB", "p1"));
  assert.equal((await del(A, "oxford")).status, 404); // already gone
  assert.equal((await post(A, "oxford", good)).status, 201);
});

test("deleted reviews drop out of the average, count and distribution", async () => {
  deliver(A); deliver(B);
  await post(A, "oxford", { ...good, rating: 5 });
  await post(B, "oxford", { ...good, rating: 1 });
  assert.equal((await list("oxford")).body.summary.average, 3);
  await del(B, "oxford");
  const s = (await list("oxford")).body.summary;
  assert.deepEqual(s, { average: 5, count: 1, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 } });
  await del(A, "oxford");
  assert.deepEqual((await list("oxford")).body.summary, {
    average: 0, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  });
});

// ---------- listing ----------

test("zero reviews: empty state data", async () => {
  const r = await list("oxford");
  assert.deepEqual(r.body.reviews, []);
  assert.equal(r.body.hasMore, false);
  assert.equal(r.body.summary.count, 0);
});

test("summary, distribution, pagination and variant come from real rows", async () => {
  for (let i = 0; i < 8; i++) {
    db.profiles.push({ id: `u${i}`, full_name: `User ${i}` });
    deliver({ id: `u${i}` }, "p1", { size: i === 7 ? "XL" : "M", color: "Olive" });
    await post({ id: `u${i}` }, "oxford", { ...good, rating: i < 5 ? 5 : 4 });
  }
  let r = await list("oxford", { limit: "5" });
  assert.equal(r.body.summary.count, 8);
  assert.equal(r.body.summary.average, 4.6);
  assert.equal(r.body.summary.distribution[5], 5);
  assert.equal(r.body.summary.distribution[4], 3);
  assert.equal(r.body.reviews.length, 5);
  assert.equal(r.body.hasMore, true);
  assert.equal(r.body.reviews[0].authorName, "User 7"); // newest first
  assert.equal(r.body.reviews[0].variant, "XL / Olive");
  assert.equal(r.body.reviews[0].verified, true);
  r = await list("oxford", { limit: "5", page: "2" });
  assert.equal(r.body.reviews.length, 3);
  assert.equal(r.body.hasMore, false);
});

test("reviews of one product never count toward another", async () => {
  deliver(A); await post(A, "oxford", good);
  assert.equal((await list("tee")).body.summary.count, 0);
});

// ---------- eligibility endpoint ----------

test("eligibility reports delivered / reviewed state and the caller's own review", async () => {
  let e = (await elig(A)).body;
  assert.equal(e.canReview, false);
  assert.equal(e.myReview, null);
  addOrder("userA", "p1", "Shipped");
  assert.equal((await elig(A)).body.canReview, false);
  deliver(A);
  e = (await elig(A)).body;
  assert.equal(e.canReview, true);
  assert.equal(e.photosEnabled, true);
  await post(A, "oxford", good);
  e = (await elig(A)).body;
  assert.equal(e.alreadyReviewed, true);
  assert.equal(e.canReview, false);
  assert.equal(e.myReview.title, "Great fit");
  assert.equal((await elig(B)).body.myReview, null); // never someone else's
});

// ---------- photos ----------

test("photos are stored, listed, limited to 3 and cleaned up on delete", async () => {
  deliver(A);
  const r = await post(A, "oxford", good, [img("a"), img("b")]);
  assert.equal(r.status, 201);
  assert.equal(db.photos.length, 2);
  const listed = (await list("oxford")).body.reviews[0];
  assert.equal(listed.photos.length, 2);
  assert.match(listed.photos[0].url, /^https:\/\/cdn\.test\//);

  assert.equal((await del(A, "oxford")).status, 200);
  assert.equal(db.photos.length, 0);
  assert.equal(cloud.destroyed.length, 2);
});

test("more than 3 photos is rejected before anything is uploaded", async () => {
  deliver(A);
  const r = await post(A, "oxford", good, [img("a"), img("b"), img("c"), img("d")]);
  assert.equal(r.status, 400);
  assert.equal(cloud.uploaded.length, 0);
  assert.equal(db.reviews.length, 0);
});

test("without the photos table, photo posts get a clear 503 and text reviews still work", async () => {
  db.photosTable = false;
  deliver(A);
  const r = await post(A, "oxford", good, [img("a")]);
  assert.equal(r.status, 503);
  assert.equal(db.reviews.length, 0);
  assert.equal((await post(A, "oxford", good)).status, 201);
  assert.equal((await list("oxford")).status, 200);
  assert.equal((await elig(A)).body.photosEnabled, false);
});

test("upload failure saves nothing; edit can add and remove only own photos", async () => {
  deliver(A); deliver(B);
  cloud.fail = true;
  assert.equal((await post(A, "oxford", good, [img("a")])).status, 502);
  assert.equal(db.reviews.length, 0);
  cloud.fail = false;

  await post(A, "oxford", good, [img("a"), img("b")]);
  await post(B, "oxford", good, [img("x")]);
  const mine = db.photos.filter((p) => p.review_id === reviewId("userA", "p1"));
  const theirs = db.photos.find((p) => p.review_id === reviewId("userB", "p1"));

  // Trying to remove B's photo (or exceed 3) through A's edit does nothing / fails.
  await put(A, "oxford", { ...good, removePhotos: JSON.stringify([theirs.id]) });
  assert.ok(db.photos.some((p) => p.id === theirs.id));
  const tooMany = await put(A, "oxford", good, [img("c"), img("d")]);
  assert.equal(tooMany.status, 400);

  const ok = await put(A, "oxford", { ...good, removePhotos: JSON.stringify([mine[0].id]) }, [img("c")]);
  assert.equal(ok.status, 200);
  const now = db.photos.filter((p) => p.review_id === reviewId("userA", "p1"));
  assert.equal(now.length, 2);
  assert.ok(!now.some((p) => p.id === mine[0].id));
  assert.ok(cloud.destroyed.includes(mine[0].public_id));
});
