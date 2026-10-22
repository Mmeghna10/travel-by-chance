// Against a REAL Redis. Runs when TEST_REDIS_URL is set (CI starts a Redis
// service container); skipped otherwise, and says so.
//   TEST_REDIS_URL=redis://localhost:6379 npm test
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Listing = require("../models/listing.js");
const { connectRedis, getRedis, closeRedis } = require("../modules/cache/redis.js");
const h = require("./helpers.js");

const url = process.env.TEST_REDIS_URL;
const skip = url ? false : "TEST_REDIS_URL not set (CI runs these against a real Redis)";

let host;
before(async () => {
  if (skip) return;
  await h.startDb();
  const client = await connectRedis(url, { startupWaitMs: 5000 });
  assert.ok(client.isReady, `could not connect to ${url}`);
});
after(async () => {
  if (skip) return;
  await closeRedis();
  await h.stopDb();
});
beforeEach(async () => {
  if (skip) return;
  await h.resetDb();
  await getRedis().flushDb();
  host = await h.createUser("host", "admin");
});

test("rate limit is shared by two app instances (as behind a load balancer)", { skip }, async () => {
  // Two separate Express apps = two web instances, each with its own
  // in-memory fallback, sharing one Redis. authMax 3 in total, not 3 each.
  const a = h.buildApp({ authMax: 3 });
  const b = h.buildApp({ authMax: 3 });
  const attempt = (app) => h.request(app).post("/login").type("form").send({ username: "x", password: "y" });
  const statuses = [];
  for (const app of [a, b, a, b]) statuses.push((await attempt(app)).status);
  assert.deepEqual(
    statuses.map((s) => s === 429),
    [false, false, false, true],
  );
  const keys = await getRedis().keys("tbc:rl:auth:*");
  assert.equal(keys.length, 1, "one shared counter");
  assert.ok((await getRedis().pTTL(keys[0])) > 0, "counter expires with the window");
});

test("listing cache round trip through real Redis, invalidated by a write", { skip }, async () => {
  const app = h.buildApp();
  const listing = await h.createListing(host, { title: "Redis Cabin" });
  await h.request(app).get("/listings");
  const cached = await getRedis().keys("tbc:listings:*:browse:*");
  assert.equal(cached.length, 1);
  assert.ok((await getRedis().ttl(cached[0])) > 0, "cache entries always expire");

  await Listing.collection.updateOne({ _id: listing._id }, { $set: { title: "Hidden Change" } });
  assert.ok((await h.request(app).get("/listings")).text.includes("Redis Cabin"), "served from Redis");

  listing.title = "Visible Change";
  await listing.save();
  assert.ok((await h.request(app).get("/listings")).text.includes("Visible Change"));
});

test("readiness shows Redis ok", { skip }, async () => {
  const res = await h.request(h.buildApp()).get("/readyz");
  assert.equal(res.body.redis, "ok");
});
