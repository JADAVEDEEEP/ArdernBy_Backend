// Address coordinates: validation, and that the service works both before and after the
// address_coordinates_phase1 migration. The pool is faked, so no database is touched.
const test = require("node:test");
const assert = require("node:assert/strict");

const queries = [];
let columnsPresent = false;

const fakePool = {
  async execute(sql, params = []) {
    const text = sql.replace(/\s+/g, " ").trim();
    queries.push({ text, params });
    if (/information_schema\.columns/i.test(text)) {
      return [columnsPresent ? [{ COLUMN_NAME: "latitude" }, { COLUMN_NAME: "longitude" }] : [], []];
    }
    if (/^select/i.test(text)) {
      return [[{ id: "a1", user_id: "u1", latitude: columnsPresent ? "23.0855700" : undefined, longitude: columnsPresent ? "72.5587700" : undefined }], []];
    }
    return [{ affectedRows: 1 }, []];
  },
};

const sqlPath = require.resolve("../config/sql");
require.cache[sqlPath] = { id: sqlPath, filename: sqlPath, loaded: true, exports: { poolPromise: Promise.resolve(fakePool) } };
const service = require("../services/address.service");

const base = { name: "A", phone: "9876543210", pincode: "382470", address: "36, Krishna Bunglows Rd", city: "Ahmedabad", state: "Gujarat", addressType: "Home" };
const insertOf = () => queries.find((q) => /^insert into addresses/i.test(q.text));

test("normalizeCoordinates: absent, cleared, valid and invalid input", () => {
  const n = service.normalizeCoordinates;
  assert.equal(n(undefined, undefined), undefined); // not sent: leave stored values alone
  assert.deepEqual(n(null, null), { latitude: null, longitude: null });
  assert.deepEqual(n("", ""), { latitude: null, longitude: null });
  assert.deepEqual(n("23.08557", 72.55877), { latitude: 23.08557, longitude: 72.55877 });
  assert.deepEqual(n(23.123456789, 72.1), { latitude: 23.1234568, longitude: 72.1 }); // 7 dp
  assert.deepEqual(n(0, 0), { latitude: 0, longitude: 0 }); // 0 is a real coordinate, not "empty"
  for (const [lat, lng] of [[91, 72], [-91, 72], [23, 181], [23, -181], ["abc", 72], [23, "x"], [23, null], [null, 72], [NaN, 1], [Infinity, 1], [{}, 1], [[], 1]]) {
    assert.throws(() => n(lat, lng), /atitude/, `should reject ${String(lat)}, ${String(lng)}`);
  }
});

test("before the migration: coordinates are ignored and the INSERT is unchanged", async () => {
  queries.length = 0;
  columnsPresent = false;
  const saved = await service.createAddress("u1", { ...base, latitude: 23.08557, longitude: 72.55877 });
  const insert = insertOf();
  assert.ok(insert);
  assert.doesNotMatch(insert.text, /latitude|longitude/);
  assert.equal(saved.latitude, null);
  assert.equal(saved.longitude, null);
  assert.ok(queries.filter((q) => /^select/i.test(q.text) && !/information_schema/i.test(q.text)).every((q) => !/latitude/.test(q.text)));
});

test("after the migration: coordinates are saved and returned as numbers", async () => {
  // Negative answers are re-checked after a minute; wait it out by resetting module state.
  delete require.cache[require.resolve("../services/address.service")];
  const fresh = require("../services/address.service");
  queries.length = 0;
  columnsPresent = true;
  const saved = await fresh.createAddress("u1", { ...base, latitude: "23.0855700", longitude: 72.55877 });
  const insert = insertOf();
  assert.match(insert.text, /latitude, longitude/);
  assert.ok(insert.params.includes(23.08557) && insert.params.includes(72.55877));
  assert.strictEqual(saved.latitude, 23.08557);
  assert.strictEqual(saved.longitude, 72.55877);
});

test("update only touches coordinates when the request carries them", async () => {
  delete require.cache[require.resolve("../services/address.service")];
  const fresh = require("../services/address.service");
  columnsPresent = true;

  queries.length = 0;
  await fresh.updateAddress("u1", "a1", { ...base, isDefault: false });
  assert.doesNotMatch(queries.find((q) => /^update addresses set name/i.test(q.text)).text, /latitude/);

  queries.length = 0;
  await fresh.updateAddress("u1", "a1", { ...base, isDefault: false, latitude: 23.1, longitude: 72.6 });
  assert.match(queries.find((q) => /^update addresses set name/i.test(q.text)).text, /latitude = \?, longitude = \?/);

  queries.length = 0;
  await fresh.updateAddress("u1", "a1", { ...base, isDefault: false, latitude: null, longitude: null });
  const clear = queries.find((q) => /^update addresses set name/i.test(q.text));
  assert.match(clear.text, /latitude = \?/);
  assert.ok(clear.params.includes(null));
});

test("invalid coordinates are rejected before any write", async () => {
  delete require.cache[require.resolve("../services/address.service")];
  const fresh = require("../services/address.service");
  columnsPresent = true;
  queries.length = 0;
  await assert.rejects(fresh.createAddress("u1", { ...base, latitude: 95, longitude: 72 }), /atitude/);
  await assert.rejects(fresh.updateAddress("u1", "a1", { ...base, latitude: 23, longitude: null }), /atitude/);
  assert.equal(queries.length, 0);
});
