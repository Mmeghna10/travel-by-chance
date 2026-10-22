const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("../models/booking.js");
const InventoryNight = require("../models/inventoryNight.js");
const { migrateLegacyBookings } = require("../modules/bookings/migrateLegacy.js");
const { parseDay } = require("../modules/bookings/dates.js");
const h = require("./helpers.js");

let host;
let guest;
let listing;
before(h.startDb);
after(h.stopDb);
beforeEach(async () => {
  await h.resetDb();
  host = await h.createUser("host", "admin");
  guest = await h.createUser("guest");
  listing = await h.createListing(host, { units: 1 });
});

// Inserts a booking exactly like the old code did: no status, no inventory.
async function legacyBooking(checkIn, checkOut, createdAt) {
  const { insertedId } = await Booking.collection.insertOne({
    listing: listing._id,
    user: guest._id,
    checkIn: parseDay(checkIn),
    checkOut: parseDay(checkOut),
    totalPrice: 2340,
    createdAt,
  });
  return insertedId;
}

test("dry run reports but writes nothing", async () => {
  await legacyBooking(h.day(10), h.day(12), new Date(1));
  const report = await migrateLegacyBookings({ apply: false });
  assert.equal(report.scanned, 1);
  assert.equal(report.migrated, 1);
  assert.equal(await Booking.countDocuments({ status: "CONFIRMED" }), 0);
  const reserved = await InventoryNight.find({ reserved: { $gt: 0 } });
  assert.equal(reserved.length, 0);
});

test("apply reserves future nights, keeps the oldest of overlapping bookings, reports the rest", async () => {
  const first = await legacyBooking(h.day(10), h.day(13), new Date(1000));
  const clash = await legacyBooking(h.day(12), h.day(14), new Date(2000)); // overlaps night day(12)
  const past = await legacyBooking(h.day(-10), h.day(-8), new Date(500));

  const report = await migrateLegacyBookings({ apply: true });
  assert.equal(report.scanned, 3);
  assert.equal(report.migrated, 2);
  assert.equal(report.pastStays, 1);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].bookingId, String(clash));

  assert.equal((await Booking.findById(first)).status, "CONFIRMED");
  assert.equal((await Booking.findById(first)).amountPaise, 234000);
  assert.equal((await Booking.findById(past)).status, "CONFIRMED");
  assert.equal((await Booking.findById(clash)).status, undefined, "left for an admin to resolve");

  const reservedOn = async (d) => (await InventoryNight.findOne({ listing: listing._id, date: parseDay(d) }))?.reserved ?? 0;
  assert.equal(await reservedOn(h.day(10)), 1);
  assert.equal(await reservedOn(h.day(12)), 1);
  assert.equal(await reservedOn(h.day(13)), 0, "the conflicting booking's partial nights were undone");

  // Running again is a no-op for migrated bookings.
  const again = await migrateLegacyBookings({ apply: true });
  assert.equal(again.scanned, 1);
  assert.equal(again.migrated, 0);
  assert.equal(await reservedOn(h.day(10)), 1);
});
