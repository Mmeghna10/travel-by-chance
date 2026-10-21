// Races between the actors that can change a booking at the same moment.
// Each scenario is repeated on many fresh bookings to give the scheduler
// plenty of chances to interleave differently, then checks the database for
// the invariants that must hold whichever side wins.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("../models/booking.js");
const InventoryNight = require("../models/inventoryNight.js");
const { createBooking } = require("../modules/bookings/service.js");
const { confirmPayment, cancelBooking, expireStaleHolds } = require("../modules/bookings/lifecycle.js");
const h = require("./helpers.js");

const ROUNDS = 20;
// Random 0-8 ms start delay so different interleavings actually happen;
// without it one side tends to win every time and the other order goes untested.
const jittered = (fn) => new Promise((r) => setTimeout(r, Math.random() * 8)).then(fn);
const afterHold = () => new Date(Date.now() + 16 * 60 * 1000);

let host;
let guest;
before(h.startDb);
after(h.stopDb);
beforeEach(async () => {
  await h.resetDb();
  host = await h.createUser("host", "admin");
  guest = await h.createUser("guest");
});

// A fresh listing + PENDING_PAYMENT booking per round, created through the real service.
async function pendingBooking(i, { holdMinutes = 15 } = {}) {
  const listing = await h.createListing(host, { title: `L${i}`, units: 1 });
  const { body } = await createBooking({
    userId: guest._id,
    listingId: String(listing._id),
    checkIn: h.day(10),
    checkOut: h.day(13),
    idempotencyKey: h.newKey(),
    requirePayment: true,
    holdMinutes,
  });
  return { listing, id: body.booking.id };
}

async function reservedCounts(listing) {
  return (await InventoryNight.find({ listing: listing._id }).sort({ date: 1 }).lean()).map((n) => n.reserved);
}

test("payment vs expiry at the same moment: the paid booking always ends CONFIRMED with its nights held", async (t) => {
  const outcomes = {};
  for (let i = 0; i < ROUNDS; i++) {
    const { listing, id } = await pendingBooking(i);
    const [payment] = await Promise.all([
      jittered(() => confirmPayment({ bookingId: id })),
      jittered(() => expireStaleHolds({ now: afterHold() })),
    ]);
    outcomes[payment.outcome] = (outcomes[payment.outcome] || 0) + 1;

    const b = await Booking.findById(id);
    assert.equal(b.status, "CONFIRMED", `round ${i}: ${payment.outcome}`);
    assert.deepEqual(await reservedCounts(listing), [1, 1, 1], `round ${i}: nights held exactly once`);
  }
  // Both orders are fine: CONFIRMED (payment first) or CONFIRMED_LATE (expiry first, then re-held).
  t.diagnostic(`winners: ${JSON.stringify(outcomes)}`);
  assert.ok(Object.keys(outcomes).every((o) => ["CONFIRMED", "CONFIRMED_LATE"].includes(o)), JSON.stringify(outcomes));
});

test("cancel vs payment at the same moment: always ends REFUND_PENDING with nights released", async (t) => {
  const paths = {};
  // Whichever wins, the guest both paid and cancelled, so money must go back
  // and the nights must be free: CONFIRMED->REFUND_PENDING (cancel after
  // payment) or CANCELLED->REFUND_PENDING (payment after cancel).
  for (let i = 0; i < ROUNDS; i++) {
    const { listing, id } = await pendingBooking(i);
    await Promise.all([
      jittered(() => confirmPayment({ bookingId: id })),
      jittered(() => cancelBooking({ bookingId: id, userId: guest._id })),
    ]);

    const b = await Booking.findById(id);
    const path = b.statusHistory.map((e) => e.to).join(">");
    paths[path] = (paths[path] || 0) + 1;
    assert.equal(b.status, "REFUND_PENDING", `round ${i}`);
    assert.ok(b.paidAt && b.cancelledAt);
    assert.deepEqual(await reservedCounts(listing), [0, 0, 0], `round ${i}: released exactly once`);
  }
  t.diagnostic(`paths: ${JSON.stringify(paths)}`);
});

test("two expiry workers at once: every stale hold expires exactly once, inventory never negative", async () => {
  const listings = [];
  for (let i = 0; i < 20; i++) listings.push((await pendingBooking(i)).listing);

  const [a, b] = await Promise.all([expireStaleHolds({ now: afterHold() }), expireStaleHolds({ now: afterHold() })]);
  assert.equal(a.expired + b.expired, 20, `worker A ${a.expired}, worker B ${b.expired}`);
  assert.equal(await Booking.countDocuments({ status: "EXPIRED" }), 20);
  for (const l of listings) assert.deepEqual(await reservedCounts(l), [0, 0, 0]);
  const expiredTwice = await Booking.countDocuments({ "statusHistory.1": { $exists: true }, "statusHistory.2": { $exists: true } });
  assert.equal(expiredTwice, 0, "no booking has two transitions recorded");
});

test("ten simultaneous cancels of one booking: one transition, nights released once", async () => {
  const { listing, id } = await pendingBooking(0);
  const results = await Promise.all(Array.from({ length: 10 }, () => cancelBooking({ bookingId: id, userId: guest._id })));
  assert.equal(results.filter((r) => r.changed).length, 1);
  const b = await Booking.findById(id);
  assert.equal(b.statusHistory.filter((e) => e.to === "CANCELLED").length, 1);
  assert.deepEqual(await reservedCounts(listing), [0, 0, 0]);
});

test("twenty duplicate payment events at once: confirmed once", async () => {
  const { listing, id } = await pendingBooking(0);
  const results = await Promise.all(Array.from({ length: 20 }, () => confirmPayment({ bookingId: id })));
  assert.equal(results.filter((r) => r.outcome === "CONFIRMED").length, 1);
  assert.equal(results.filter((r) => r.outcome === "ALREADY_CONFIRMED").length, 19);
  const b = await Booking.findById(id);
  assert.equal(b.statusHistory.filter((e) => e.to === "CONFIRMED").length, 1);
  assert.deepEqual(await reservedCounts(listing), [1, 1, 1]);
});

test("late payment racing a new guest for the released nights: never double-booked", async (t) => {
  let rivalWins = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const { listing, id } = await pendingBooking(i);
    await expireStaleHolds({ now: afterHold() });
    const rival = await h.createUser(`rival${i}`);

    const [payment, rivalResult] = await Promise.all([
      jittered(() => confirmPayment({ bookingId: id })),
      jittered(() => createBooking({
        userId: rival._id,
        listingId: String(listing._id),
        checkIn: h.day(11),
        checkOut: h.day(12),
        idempotencyKey: h.newKey(),
      })).catch((err) => ({ error: err.code })),
    ]);

    const rivalWon = !rivalResult.error;
    if (rivalWon) rivalWins++;
    // Exactly one of them gets night day(11).
    if (rivalWon) assert.equal(payment.outcome, "REFUND_REQUIRED", `round ${i}`);
    else assert.equal(payment.outcome, "CONFIRMED_LATE", `round ${i}`);
    const counts = await reservedCounts(listing);
    assert.ok(counts.every((c) => c <= 1), `round ${i}: ${counts}`);
    assert.equal(counts[1], 1, `round ${i}: night day(11) sold exactly once`);
  }
  t.diagnostic(`rival won ${rivalWins}/${ROUNDS}, late payment won ${ROUNDS - rivalWins}/${ROUNDS}`);
});
