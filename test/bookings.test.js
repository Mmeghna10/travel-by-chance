const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("../models/booking.js");
const InventoryNight = require("../models/inventoryNight.js");
const IdempotencyRecord = require("../models/idempotencyRecord.js");
const Listing = require("../models/listing.js");
const { parseDay } = require("../modules/bookings/dates.js");
const h = require("./helpers.js");

let app;
let host;
let listing;
before(async () => {
  await h.startDb();
  app = h.buildApp();
});
after(h.stopDb);
beforeEach(async () => {
  await h.resetDb();
  host = await h.createUser("host", "admin");
  listing = await h.createListing(host, { price: 1000, units: 1 });
});

const book = (agent, body, key = h.newKey()) =>
  agent.post("/api/v1/bookings").set("Idempotency-Key", key).send({ listingId: String(listing._id), ...body });

async function reservedOn(dateStr) {
  const doc = await InventoryNight.findOne({ listing: listing._id, date: parseDay(dateStr) });
  return doc ? doc.reserved : 0;
}

test("creates a CONFIRMED booking with a server-computed price and reserves each night", async () => {
  await h.createUser("guest");
  const agent = await h.loginAgent(app, "guest");

  const res = await book(agent, { checkIn: h.day(10), checkOut: h.day(13) });
  assert.equal(res.status, 201);
  assert.equal(res.body.booking.status, "CONFIRMED");
  assert.equal(res.body.booking.nights, 3);
  assert.equal(res.body.booking.amountPaise, 317000);

  const saved = await Booking.findById(res.body.booking.id);
  assert.equal(saved.status, "CONFIRMED");
  assert.equal(saved.totalPrice, 3170);
  assert.equal(await reservedOn(h.day(10)), 1);
  assert.equal(await reservedOn(h.day(12)), 1);
  assert.equal(await reservedOn(h.day(13)), 0, "check-out day stays free");
});

test("a client-supplied price is ignored", async () => {
  await h.createUser("guest");
  const agent = await h.loginAgent(app, "guest");
  const res = await book(agent, { checkIn: h.day(10), checkOut: h.day(11), totalPrice: 1, amountPaise: 1 });
  assert.equal(res.status, 201);
  assert.equal(res.body.booking.amountPaise, 117000);
});

test("rejects unauthenticated, keyless and invalid requests without side effects", async () => {
  const anon = await h.request(app).post("/api/v1/bookings").set("Idempotency-Key", h.newKey()).send({});
  assert.equal(anon.status, 401);

  await h.createUser("guest");
  const agent = await h.loginAgent(app, "guest");
  const noKey = await agent.post("/api/v1/bookings").send({ listingId: String(listing._id), checkIn: h.day(1), checkOut: h.day(2) });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.code, "IDEMPOTENCY_KEY_REQUIRED");

  for (const [checkIn, checkOut] of [[h.day(-2), h.day(1)], [h.day(5), h.day(5)], ["2026-02-30", h.day(3)], [h.day(1), h.day(40)]]) {
    const res = await book(agent, { checkIn, checkOut });
    assert.equal(res.status, 400, `${checkIn}..${checkOut}`);
    assert.equal(res.body.code, "INVALID_DATES");
  }
  assert.equal(await Booking.countDocuments(), 0);
  assert.equal(await IdempotencyRecord.countDocuments(), 0);
});

test("overlapping stays conflict; back-to-back stays don't", async () => {
  await h.createUser("a");
  await h.createUser("b");
  await h.createUser("c");
  const [a, b, c] = await Promise.all(["a", "b", "c"].map((u) => h.loginAgent(app, u)));

  assert.equal((await book(a, { checkIn: h.day(10), checkOut: h.day(13) })).status, 201);
  const overlap = await book(b, { checkIn: h.day(12), checkOut: h.day(15) });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.code, "SOLD_OUT");
  // Check-in on the previous guest's check-out day is fine.
  assert.equal((await book(c, { checkIn: h.day(13), checkOut: h.day(15) })).status, 201);
});

test("a multi-night stay is all-or-nothing: no partial reservations when one night is full", async () => {
  await h.createUser("a");
  await h.createUser("b");
  const a = await h.loginAgent(app, "a");
  const b = await h.loginAgent(app, "b");

  // Night day(11) is taken...
  assert.equal((await book(a, { checkIn: h.day(11), checkOut: h.day(12) })).status, 201);
  // ...so day(10)..day(13) must fail, and day(10) must NOT stay incremented
  // even though it was reserved before the transaction hit day(11).
  assert.equal((await book(b, { checkIn: h.day(10), checkOut: h.day(13) })).status, 409);
  assert.equal(await reservedOn(h.day(10)), 0);
  assert.equal(await reservedOn(h.day(11)), 1);
  assert.equal(await reservedOn(h.day(12)), 0);
  assert.equal(await Booking.countDocuments(), 1);
});

test("a failure after inventory was reserved rolls everything back", async () => {
  await h.createUser("guest");
  const agent = await h.loginAgent(app, "guest");

  // Simulate a crash/DB error at the last step of the transaction.
  const realCreate = Booking.create;
  Booking.create = async () => {
    throw new Error("simulated failure while inserting the booking");
  };
  try {
    const res = await book(agent, { checkIn: h.day(10), checkOut: h.day(12) });
    assert.equal(res.status, 500);
  } finally {
    Booking.create = realCreate;
  }

  assert.equal(await reservedOn(h.day(10)), 0, "inventory increment rolled back");
  assert.equal(await reservedOn(h.day(11)), 0);
  assert.equal(await IdempotencyRecord.countDocuments(), 0, "idempotency key released");
  assert.equal(await Booking.countDocuments(), 0);

  // ...so retrying with a fresh attempt works.
  assert.equal((await book(agent, { checkIn: h.day(10), checkOut: h.day(12) })).status, 201);
});

test("retrying with the same Idempotency-Key replays the original response", async () => {
  await h.createUser("guest");
  const agent = await h.loginAgent(app, "guest");
  const key = h.newKey();
  const body = { checkIn: h.day(10), checkOut: h.day(12) };

  const first = await book(agent, body, key);
  const second = await book(agent, body, key);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.headers["idempotent-replayed"], "true");
  assert.deepEqual(second.body, first.body);
  assert.equal(await Booking.countDocuments(), 1);
  assert.equal(await reservedOn(h.day(10)), 1);
});

test("reusing a key with a different payload is rejected", async () => {
  await h.createUser("guest");
  const agent = await h.loginAgent(app, "guest");
  const key = h.newKey();
  assert.equal((await book(agent, { checkIn: h.day(10), checkOut: h.day(12) }, key)).status, 201);
  const res = await book(agent, { checkIn: h.day(20), checkOut: h.day(22) }, key);
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(await Booking.countDocuments(), 1);
});

test("idempotency keys are per user: another user's key doesn't collide", async () => {
  await h.createUser("a");
  await h.createUser("b");
  await Listing.updateOne({ _id: listing._id }, { units: 2 });
  const key = h.newKey();
  const a = await h.loginAgent(app, "a");
  const b = await h.loginAgent(app, "b");
  const ra = await book(a, { checkIn: h.day(10), checkOut: h.day(11) }, key);
  const rb = await book(b, { checkIn: h.day(10), checkOut: h.day(11) }, key);
  assert.equal(ra.status, 201);
  assert.equal(rb.status, 201);
  assert.notEqual(ra.body.booking.id, rb.body.booking.id);
});

test("quote endpoint prices a stay and reports availability", async () => {
  const q = await h.request(app).get(`/api/v1/listings/${listing._id}/quote`).query({ checkIn: h.day(10), checkOut: h.day(13) });
  assert.equal(q.status, 200);
  assert.equal(q.body.available, true);
  assert.equal(q.body.quote.totalPaise, 317000);

  await h.createUser("guest");
  const agent = await h.loginAgent(app, "guest");
  await book(agent, { checkIn: h.day(11), checkOut: h.day(12) });
  const after = await h.request(app).get(`/api/v1/listings/${listing._id}/quote`).query({ checkIn: h.day(10), checkOut: h.day(13) });
  assert.equal(after.body.available, false);
  assert.equal(after.body.unitsLeft, 0);

  const bad = await h.request(app).get(`/api/v1/listings/${listing._id}/quote`).query({ checkIn: "x", checkOut: "y" });
  assert.equal(bad.status, 400);
});

test("users only see their own bookings", async () => {
  await h.createUser("a");
  await h.createUser("b");
  const other = await h.createListing(host, { title: "Secret Villa" });
  const a = await h.loginAgent(app, "a");
  const b = await h.loginAgent(app, "b");
  await a.post("/api/v1/bookings").set("Idempotency-Key", h.newKey()).send({ listingId: String(other._id), checkIn: h.day(5), checkOut: h.day(6) });

  const pageA = await a.get("/bookings");
  const pageB = await b.get("/bookings");
  assert.ok(pageA.text.includes("Secret Villa"));
  assert.ok(!pageB.text.includes("Secret Villa"));
});

test("a listing with upcoming bookings can't be deleted; one without can", async () => {
  await h.createUser("guest");
  const guest = await h.loginAgent(app, "guest");
  const hostAgent = await h.loginAgent(app, "host");
  await book(guest, { checkIn: h.day(5), checkOut: h.day(6) });

  await hostAgent.post(`/listings/${listing._id}?_method=DELETE`);
  assert.ok(await Listing.exists({ _id: listing._id }), "still there");

  const empty = await h.createListing(host, { title: "Empty" });
  await hostAgent.post(`/listings/${empty._id}?_method=DELETE`);
  assert.equal(await Listing.exists({ _id: empty._id }), null);
});

test("existing listings without a units field default to 1", async () => {
  await Listing.collection.updateOne({ _id: listing._id }, { $unset: { units: "" } });
  const loaded = await Listing.findById(listing._id);
  assert.equal(loaded.units, 1);
});
