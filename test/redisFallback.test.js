// Listing cache + rate-limit store behaviour, with an in-memory stand-in for
// Redis so it runs everywhere. The same paths are exercised against a REAL
// Redis in test/redis.integration.test.js (CI provides one).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Listing = require("../models/listing.js");
const { setRedisClient } = require("../modules/cache/redis.js");
const { GEN_KEY } = require("../modules/cache/listingCache.js");
const h = require("./helpers.js");

// Just enough of the node-redis client API for the cache. sendCommand (used by
// the rate-limit store's Lua scripts) isn't faked: it fails, like a broken Redis.
function fakeRedis() {
  const data = new Map();
  return {
    data,
    isReady: true,
    broken: false,
    check() {
      if (this.broken) throw new Error("connection lost");
    },
    async get(k) {
      this.check();
      return data.has(k) ? data.get(k) : null;
    },
    async set(k, v) {
      this.check();
      data.set(k, v);
      return "OK";
    },
    async incr(k) {
      this.check();
      const n = Number(data.get(k) || 0) + 1;
      data.set(k, String(n));
      return n;
    },
    async sendCommand() {
      throw new Error("fake redis: no scripting");
    },
  };
}

let app;
let redis;
let host;
before(async () => {
  await h.startDb();
  app = h.buildApp();
});
after(h.stopDb);
beforeEach(async () => {
  await h.resetDb();
  redis = fakeRedis();
  setRedisClient(redis);
  host = await h.createUser("host", "admin");
});

// Changes the title WITHOUT Mongoose hooks, i.e. without invalidating, so we
// can tell whether a page came from the cache or from the database.
const sneakyRename = (listing, title) => Listing.collection.updateOne({ _id: listing._id }, { $set: { title } });

test("browse page: second request is served from the cache", async () => {
  const listing = await h.createListing(host, { title: "Original Cabin" });
  const first = await h.request(app).get("/listings");
  assert.ok(first.text.includes("Original Cabin"));

  await sneakyRename(listing, "Renamed Cabin");
  const second = await h.request(app).get("/listings");
  assert.ok(second.text.includes("Original Cabin"), "cached copy served");
  assert.ok(!second.text.includes("Renamed Cabin"));
});

test("saving a listing through the app invalidates every cached listing page", async () => {
  const listing = await h.createListing(host, { title: "Original Cabin" });
  await h.request(app).get("/listings");
  await h.request(app).get("/listings?category=Mountains");
  const genBefore = Number(redis.data.get(GEN_KEY) || 0);

  listing.title = "Updated Cabin";
  await listing.save(); // Mongoose hook bumps the generation

  assert.equal(Number(redis.data.get(GEN_KEY)), genBefore + 1);
  for (const url of ["/listings", "/listings?category=Mountains"]) {
    const page = await h.request(app).get(url);
    assert.ok(page.text.includes("Updated Cabin"), `${url} shows the new title`);
  }
});

test("adding a review (listing.reviews changes) also invalidates", async () => {
  const listing = await h.createListing(host, { title: "Reviewed Cabin" });
  await h.createUser("guest");
  const guest = await h.loginAgent(app, "guest");
  await h.request(app).get("/listings");
  const gen = Number(redis.data.get(GEN_KEY) || 0);
  await guest.post(`/listings/${listing._id}/reviews`).type("form").send({ review: { rating: 4, comment: "Lovely" } });
  assert.ok(Number(redis.data.get(GEN_KEY)) > gen);
});

test("search suggestions are cached per query", async () => {
  const listing = await h.createListing(host, { title: "Lakeside Villa" });
  const first = await h.request(app).get("/api/search-suggestions?q=lakes");
  assert.equal(first.body[0].title, "Lakeside Villa");
  await sneakyRename(listing, "Lakeside Hut");
  const second = await h.request(app).get("/api/search-suggestions?q=Lakes");
  assert.equal(second.body[0].title, "Lakeside Villa", "same query, different case: one cache entry");
});

test("a broken Redis never breaks pages: reads fall back to MongoDB", async () => {
  const listing = await h.createListing(host, { title: "Original Cabin" });
  await h.request(app).get("/listings");
  await sneakyRename(listing, "Fresh From Db");
  redis.broken = true;
  const page = await h.request(app).get("/listings");
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("Fresh From Db"));
  assert.equal((await h.request(app).get("/")).status, 200);
});

test("Redis disconnected: cache is bypassed, writes still succeed", async () => {
  redis.isReady = false;
  const listing = await h.createListing(host, { title: "Offline Cabin" });
  listing.title = "Still Saves";
  await listing.save();
  const page = await h.request(app).get("/listings");
  assert.ok(page.text.includes("Still Saves"));
  assert.equal(redis.data.size, 0, "nothing written to a disconnected Redis");
});

test("rate limits keep working (in memory) when Redis can't count", async () => {
  // A fresh app with authMax 2; this fake Redis rejects the limiter's scripts.
  const limited = h.buildApp({ authMax: 2 });
  const attempt = () => h.request(limited).post("/login").type("form").send({ username: "nobody", password: "wrong" });
  assert.notEqual((await attempt()).status, 429);
  assert.notEqual((await attempt()).status, 429);
  assert.equal((await attempt()).status, 429);
});

test("readiness reports Redis but doesn't depend on it", async () => {
  redis.isReady = false;
  const res = await h.request(app).get("/readyz");
  assert.equal(res.status, 200);
  assert.equal(res.body.redis, "down");
  setRedisClient(null);
  assert.equal((await h.request(app).get("/readyz")).body.redis, "off");
});
