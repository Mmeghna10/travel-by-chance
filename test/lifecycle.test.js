// Booking lifecycle with payment required: holds, expiry, confirmation,
// cancellation. Time is controlled by passing `now` into the services.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Booking = require("../models/booking.js");
const InventoryNight = require("../models/inventoryNight.js");
const { confirmPayment, cancelBooking, expireStaleHolds } = require("../modules/bookings/lifecycle.js");
const { applyTransition } = require("../modules/bookings/stateMachine.js");
const { parseDay } = require("../modules/bookings/dates.js");
const h = require("./helpers.js");

const HOLD_MINUTES = 15;
const minutesLater = (m) => new Date(Date.now() + m * 60 * 1000);

let app; // bookings require payment
let instantApp; // payments disabled: bookings are CONFIRMED at once
let host;
let listing;
let guest;
let agent;
before(async () => {
  await h.startDb();
  app = h.buildApp({}, { requirePayment: true, holdMinutes: HOLD_MINUTES });
  instantApp = h.buildApp();
});
after(h.stopDb);
beforeEach(async () => {
  await h.resetDb();
  host = await h.createUser("host", "admin");
  guest = await h.createUser("guest");
  listing = await h.createListing(host, { units: 1 });
  agent = await h.loginAgent(app, "guest");
});

async function hold(checkIn = h.day(10), checkOut = h.day(12), who = agent) {
  const res = await who
    .post("/api/v1/bookings")
    .set("Idempotency-Key", h.newKey())
    .send({ listingId: String(listing._id), checkIn, checkOut });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.booking.id;
}

const reservedOn = async (d) => (await InventoryNight.findOne({ listing: listing._id, date: parseDay(d) }))?.reserved ?? 0;
const statusOf = async (id) => (await Booking.findById(id)).status;

test("with payment required, a booking starts as PENDING_PAYMENT and holds its nights until expiresAt", async () => {
  const before = Date.now();
  const id = await hold();
  const b = await Booking.findById(id);
  assert.equal(b.status, "PENDING_PAYMENT");
  const holdMs = b.expiresAt.getTime() - before;
  assert.ok(holdMs > 14 * 60 * 1000 && holdMs <= 15 * 60 * 1000 + 5000, `hold ~15 min, got ${holdMs}ms`);
  assert.equal(await reservedOn(h.day(10)), 1);
  assert.deepEqual(b.statusHistory.map((e) => [e.to, e.actor]), [["PENDING_PAYMENT", "guest"]]);
});

test("expiry releases the nights after the deadline, and not before", async () => {
  const id = await hold();

  let run = await expireStaleHolds({ now: minutesLater(HOLD_MINUTES - 1) });
  assert.equal(run.expired, 0);
  assert.equal(await statusOf(id), "PENDING_PAYMENT");

  run = await expireStaleHolds({ now: minutesLater(HOLD_MINUTES + 1) });
  assert.equal(run.expired, 1);
  assert.equal(await statusOf(id), "EXPIRED");
  assert.equal(await reservedOn(h.day(10)), 0);
  assert.equal(await reservedOn(h.day(11)), 0);

  // Someone else can now book those nights.
  await h.createUser("other");
  const other = await h.loginAgent(app, "other");
  await hold(h.day(10), h.day(12), other);
});

test("expiry never touches a confirmed booking (even long after its old deadline)", async () => {
  const id = await hold();
  assert.equal((await confirmPayment({ bookingId: id })).outcome, "CONFIRMED");

  const run = await expireStaleHolds({ now: minutesLater(24 * 60) });
  assert.equal(run.expired, 0);
  assert.equal(await statusOf(id), "CONFIRMED");
  assert.equal(await reservedOn(h.day(10)), 1, "nights still held for the paying guest");
});

test("confirmPayment is idempotent: a duplicate payment event changes nothing", async () => {
  const id = await hold();
  assert.equal((await confirmPayment({ bookingId: id })).outcome, "CONFIRMED");
  assert.equal((await confirmPayment({ bookingId: id })).outcome, "ALREADY_CONFIRMED");
  const b = await Booking.findById(id);
  assert.equal(b.statusHistory.filter((e) => e.to === "CONFIRMED").length, 1);
  assert.equal(await reservedOn(h.day(10)), 1);
});

test("late payment after expiry: re-holds the nights if they are still free", async () => {
  const id = await hold();
  await expireStaleHolds({ now: minutesLater(HOLD_MINUTES + 1) });
  assert.equal(await reservedOn(h.day(10)), 0);

  assert.equal((await confirmPayment({ bookingId: id })).outcome, "CONFIRMED_LATE");
  assert.equal(await statusOf(id), "CONFIRMED");
  assert.equal(await reservedOn(h.day(10)), 1);
  assert.equal(await reservedOn(h.day(11)), 1);
});

test("late payment after expiry: if the nights were resold, the booking needs a refund and nobody is double-booked", async () => {
  const id = await hold();
  await expireStaleHolds({ now: minutesLater(HOLD_MINUTES + 1) });
  await h.createUser("other");
  const other = await h.loginAgent(app, "other");
  const otherId = await hold(h.day(11), h.day(13), other); // takes night day(11)

  assert.equal((await confirmPayment({ bookingId: id })).outcome, "REFUND_REQUIRED");
  const b = await Booking.findById(id);
  assert.equal(b.status, "REFUND_PENDING");
  assert.ok(b.paidAt);
  assert.equal(await statusOf(otherId), "PENDING_PAYMENT");
  // The failed re-hold of day(10) was rolled back with the transaction.
  assert.equal(await reservedOn(h.day(10)), 0);
  assert.equal(await reservedOn(h.day(11)), 1);
});

test("guest cancels an unpaid hold: CANCELLED and nights released", async () => {
  const id = await hold();
  const res = await agent.post(`/api/v1/bookings/${id}/cancel`);
  assert.equal(res.status, 200);
  assert.equal(res.body.booking.status, "CANCELLED");
  assert.equal(res.body.changed, true);
  assert.equal(await reservedOn(h.day(10)), 0);

  // Cancelling again is a harmless no-op.
  const again = await agent.post(`/api/v1/bookings/${id}/cancel`);
  assert.equal(again.status, 200);
  assert.equal(again.body.changed, false);
  assert.equal(await reservedOn(h.day(10)), 0, "not released twice (never negative)");
});

test("guest cancels a paid booking: REFUND_PENDING and nights released", async () => {
  const id = await hold();
  await confirmPayment({ bookingId: id });
  const res = await agent.post(`/api/v1/bookings/${id}/cancel`);
  assert.equal(res.body.booking.status, "REFUND_PENDING");
  assert.equal(await reservedOn(h.day(10)), 0);
});

test("payment arriving after the guest cancelled is flagged for refund, not confirmed", async () => {
  const id = await hold();
  await cancelBooking({ bookingId: id, userId: guest._id });
  assert.equal((await confirmPayment({ bookingId: id })).outcome, "REFUND_REQUIRED");
  assert.equal(await statusOf(id), "REFUND_PENDING");
  assert.equal(await reservedOn(h.day(10)), 0);
});

test("with payments disabled, a confirmed booking can be cancelled and its dates rebooked", async () => {
  const instantAgent = await h.loginAgent(instantApp, "guest");
  const res = await instantAgent
    .post("/api/v1/bookings")
    .set("Idempotency-Key", h.newKey())
    .send({ listingId: String(listing._id), checkIn: h.day(10), checkOut: h.day(12) });
  assert.equal(res.body.booking.status, "CONFIRMED");

  const cancel = await instantAgent.post(`/api/v1/bookings/${res.body.booking.id}/cancel`);
  assert.equal(cancel.body.booking.status, "CANCELLED", "nothing was paid, so no refund state");
  assert.equal(await reservedOn(h.day(10)), 0);
});

test("a guest cannot see or cancel someone else's booking (404, not 403)", async () => {
  const id = await hold();
  await h.createUser("mallory");
  const mallory = await h.loginAgent(app, "mallory");

  assert.equal((await mallory.get(`/api/v1/bookings/${id}`)).status, 404);
  const res = await mallory.post(`/api/v1/bookings/${id}/cancel`);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "BOOKING_NOT_FOUND");
  assert.equal(await statusOf(id), "PENDING_PAYMENT");
  assert.equal((await mallory.post(`/api/v1/bookings/not-an-id/cancel`)).status, 404);
  assert.equal((await h.request(app).post(`/api/v1/bookings/${id}/cancel`)).status, 401);

  assert.equal((await agent.get(`/api/v1/bookings/${id}`)).body.booking.status, "PENDING_PAYMENT");
});

test("a stay that has started can't be cancelled", async () => {
  const id = await hold(h.day(0), h.day(2));
  const res = await agent.post(`/api/v1/bookings/${id}/cancel`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "CANCELLATION_CLOSED");
  assert.equal(await statusOf(id), "PENDING_PAYMENT");
});

test("an expired booking can't be cancelled (invalid transition)", async () => {
  const id = await hold();
  await expireStaleHolds({ now: minutesLater(HOLD_MINUTES + 1) });
  const res = await agent.post(`/api/v1/bookings/${id}/cancel`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "INVALID_TRANSITION");
});

test("the My Bookings page cancels via a form and shows a flash message", async () => {
  const id = await hold();
  const page = await agent.get("/bookings");
  assert.ok(page.text.includes(`/bookings/${id}/cancel`), "cancel button shown");

  const res = await agent.post(`/bookings/${id}/cancel`).type("form");
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/bookings");
  const after = await agent.get("/bookings");
  assert.ok(after.text.includes("Booking cancelled."));
  assert.ok(!after.text.includes(`/bookings/${id}/cancel`), "no cancel button on a cancelled booking");
});

test("crash recovery: if expiry fails midway nothing changes, and the next run completes it", async () => {
  const id = await hold();
  let calls = 0;
  const realUpdateOne = InventoryNight.updateOne;
  InventoryNight.updateOne = function (filter, update, opts) {
    // Fail on the SECOND night: the first night has already been released at
    // that point, so this checks the release is part of the transaction.
    if (update && update.$inc && update.$inc.reserved === -1 && calls++ === 1) {
      throw new Error("simulated crash during release");
    }
    return realUpdateOne.call(this, filter, update, opts);
  };
  try {
    const run = await expireStaleHolds({ now: minutesLater(HOLD_MINUTES + 1) });
    assert.equal(run.expired, 0);
    assert.equal(await statusOf(id), "PENDING_PAYMENT", "status change rolled back with the failed release");
    assert.equal(await reservedOn(h.day(10)), 1, "first night's release rolled back too");
    assert.equal(await reservedOn(h.day(11)), 1);
  } finally {
    InventoryNight.updateOne = realUpdateOne;
  }

  const retry = await expireStaleHolds({ now: minutesLater(HOLD_MINUTES + 1) });
  assert.equal(retry.expired, 1);
  assert.equal(await statusOf(id), "EXPIRED");
  assert.equal(await reservedOn(h.day(10)), 0);
});

test("legacy bookings without a status can't be cancelled and aren't touched by expiry", async () => {
  const { insertedId } = await Booking.collection.insertOne({
    listing: listing._id,
    user: guest._id,
    checkIn: parseDay(h.day(20)),
    checkOut: parseDay(h.day(21)),
    totalPrice: 1000,
  });
  const res = await agent.post(`/api/v1/bookings/${insertedId}/cancel`);
  assert.equal(res.status, 409);
  await expireStaleHolds({ now: minutesLater(10_000) });
  assert.equal((await Booking.collection.findOne({ _id: insertedId })).status, undefined);
  assert.ok(mongoose.isValidObjectId(insertedId));
});

test("a transition based on a stale status is refused and has no side effects", async () => {
  // A caller that read the booking earlier (e.g. an expiry worker that loaded
  // it before the payment landed) must not be able to clobber the newer state.
  const id = await hold();
  const staleCopy = await Booking.findById(id); // PENDING_PAYMENT
  await confirmPayment({ bookingId: id });       // now CONFIRMED

  const changed = await mongoose.connection.transaction((session) =>
    applyTransition({ booking: staleCopy, from: "PENDING_PAYMENT", to: "EXPIRED", actor: "system", session }),
  );
  assert.equal(changed, false);
  assert.equal(await statusOf(id), "CONFIRMED");
  assert.equal(await reservedOn(h.day(10)), 1, "inventory not released for a confirmed booking");
});

test("My Bookings offers no Cancel button for pre-upgrade bookings (no status)", async () => {
  const { insertedId } = await Booking.collection.insertOne({
    listing: listing._id,
    user: guest._id,
    checkIn: parseDay(h.day(20)),
    checkOut: parseDay(h.day(21)),
    totalPrice: 1000,
    createdAt: new Date(),
  });
  const page = await agent.get("/bookings");
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes(`/bookings/${insertedId}/cancel`), "no cancel action that would only fail");
});
