// Concurrency tests against a real mongod replica set through one real HTTP
// server. Each scenario fires all requests at once with Promise.all and then
// checks the DATABASE (not just the responses) for the invariants:
//   - reserved never exceeds units and is never negative
//   - number of bookings == number of 201 responses == number of units sold
//   - one logical request (one key) never creates more than one booking
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("../models/booking.js");
const InventoryNight = require("../models/inventoryNight.js");
const IdempotencyRecord = require("../models/idempotencyRecord.js");
const h = require("./helpers.js");

let app;
let server;
let host;
before(async () => {
  await h.startDb();
  app = h.buildApp();
  server = await h.listen(app);
});
after(async () => {
  await new Promise((r) => server.close(r));
  await h.stopDb();
});
beforeEach(async () => {
  await h.resetDb();
  host = await h.createUser("host", "admin");
});

async function loggedInAgents(n, prefix) {
  const names = Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  await Promise.all(names.map((u) => h.createUser(u)));
  return Promise.all(names.map((u) => h.loginAgent(server, u)));
}

const book = (agent, listing, checkIn, checkOut, key = h.newKey()) =>
  agent.post("/api/v1/bookings").set("Idempotency-Key", key).send({ listingId: String(listing._id), checkIn, checkOut });

const countBy = (responses) =>
  responses.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});

async function assertInventoryInvariants(listing) {
  const nights = await InventoryNight.find({ listing: listing._id }).lean();
  for (const n of nights) {
    assert.ok(n.reserved >= 0, `negative inventory on ${n.date.toISOString()}`);
    assert.ok(n.reserved <= listing.units, `oversold ${n.date.toISOString()}: ${n.reserved}/${listing.units}`);
  }
  // The counters must agree with the bookings that actually exist.
  const bookings = await Booking.find({ listing: listing._id, status: "CONFIRMED" }).lean();
  for (const n of nights) {
    const holding = bookings.filter((b) => b.checkIn <= n.date && n.date < b.checkOut).length;
    assert.equal(n.reserved, holding, `counter drift on ${n.date.toISOString()}`);
  }
}

test("Scenario A: 100 users race for the last unit -> exactly one booking", async () => {
  const listing = await h.createListing(host, { units: 1 });
  const agents = await loggedInAgents(100, "racer");

  const responses = await Promise.all(agents.map((a) => book(a, listing, h.day(30), h.day(32))));
  const statuses = countBy(responses);

  assert.deepEqual(statuses, { 201: 1, 409: 99 }, JSON.stringify(statuses));
  assert.ok(responses.filter((r) => r.status === 409).every((r) => r.body.code === "SOLD_OUT"));
  assert.equal(await Booking.countDocuments({ listing: listing._id }), 1);
  await assertInventoryInvariants(listing);
});

test("Scenario A': 60 users race for 5 units -> exactly 5 bookings", async () => {
  const listing = await h.createListing(host, { units: 5 });
  const agents = await loggedInAgents(60, "dorm");

  const responses = await Promise.all(agents.map((a) => book(a, listing, h.day(30), h.day(33))));
  assert.deepEqual(countBy(responses), { 201: 5, 409: 55 });
  assert.equal(await Booking.countDocuments({ listing: listing._id }), 5);
  await assertInventoryInvariants(listing);
});

test("overlapping (not identical) stays racing for one unit never double-book any night", async () => {
  const listing = await h.createListing(host, { units: 1 });
  const agents = await loggedInAgents(40, "overlap");
  // 40 different ranges, all overlapping somewhere within days 30..40.
  const responses = await Promise.all(
    agents.map((a, i) => book(a, listing, h.day(30 + (i % 8)), h.day(32 + (i % 8)))),
  );
  const ok = responses.filter((r) => r.status === 201);
  assert.ok(ok.length >= 1);
  assert.equal(ok.length + responses.filter((r) => r.status === 409).length, 40, "only 201 or 409");
  await assertInventoryInvariants(listing);
});

test("Scenario B: the same request sent 20 times at once (same key) -> one booking, same answer", async () => {
  const listing = await h.createListing(host, { units: 3 });
  const [agent] = await loggedInAgents(1, "clicker");
  const key = h.newKey();

  const responses = await Promise.all(Array.from({ length: 20 }, () => book(agent, listing, h.day(30), h.day(31), key)));

  assert.deepEqual(countBy(responses), { 201: 20 });
  const ids = new Set(responses.map((r) => r.body.booking.id));
  assert.equal(ids.size, 1, "every retry returns the same booking id");
  assert.equal(await Booking.countDocuments(), 1);
  assert.equal(await IdempotencyRecord.countDocuments(), 1);
  const night = await InventoryNight.findOne({ listing: listing._id });
  assert.equal(night.reserved, 1, "only one unit consumed despite 3 being available");
});

test("different keys from the same user compete like different users", async () => {
  const listing = await h.createListing(host, { units: 1 });
  const [agent] = await loggedInAgents(1, "multitab");
  const responses = await Promise.all(Array.from({ length: 10 }, () => book(agent, listing, h.day(30), h.day(31))));
  assert.deepEqual(countBy(responses), { 201: 1, 409: 9 });
  await assertInventoryInvariants(listing);
});
