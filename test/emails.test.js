// Booking emails: queued in the same transaction as the booking change,
// sent by the worker with retries. The SMTP transport is a stand-in.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("../models/booking.js");
const EmailOutbox = require("../models/emailOutbox.js");
const { configurePayments } = require("../modules/payments/gateway.js");
const { processRefundQueue } = require("../modules/payments/refunds.js");
const { expireStaleHolds } = require("../modules/bookings/lifecycle.js");
const { processEmailQueue, MAX_ATTEMPTS } = require("../modules/notifications/outbox.js");
const { setMailTransport } = require("../modules/notifications/mailer.js");
const { buildEmail } = require("../modules/notifications/templates.js");
const h = require("./helpers.js");

const sent = [];
let failNext = 0;
const fakeTransport = {
  async sendMail(msg) {
    if (failNext > 0) {
      failNext--;
      throw new Error("SMTP 421 try again later");
    }
    sent.push(msg);
    return { messageId: `m${sent.length}` };
  },
};
const later = (minutes) => new Date(Date.now() + minutes * 60_000);

let instantApp;
let payApp;
let listing;
before(async () => {
  await h.startDb();
  instantApp = h.buildApp({}, { requirePayment: false });
  payApp = h.buildApp({}, { requirePayment: true, holdMinutes: 15 });
});
after(async () => {
  setMailTransport(null);
  await h.stopDb();
});
beforeEach(async () => {
  await h.resetDb();
  sent.length = 0;
  failNext = 0;
  setMailTransport(fakeTransport, "TravelByChance <bookings@example.com>", "https://tbc.example");
  configurePayments({ demo: true, demoSecret: "test-app-secret" });
  const host = await h.createUser("host", "admin");
  await h.createUser("guest");
  listing = await h.createListing(host, { title: "Goa <b>Villa</b>", location: "Goa", price: 1000, units: 1 });
});

const book = (agent, from = 10) =>
  agent.post("/api/v1/bookings").set("Idempotency-Key", h.newKey()).send({ listingId: String(listing._id), checkIn: h.day(from), checkOut: h.day(from + 2) });
const events = async () => (await EmailOutbox.find().sort({ createdAt: 1 })).map((e) => e.event);

test("instant booking: confirmation queued with the booking, sent once, with the right details", async () => {
  const guest = await h.loginAgent(instantApp, "guest");
  const res = await book(guest);
  assert.equal(res.body.booking.status, "CONFIRMED");
  assert.deepEqual(await events(), ["booking_confirmed"]);

  assert.deepEqual(await processEmailQueue(), { SENT: 1, RETRY: 0, GAVE_UP: 0, SKIPPED: 0 });
  assert.equal(sent.length, 1);
  const [msg] = sent;
  assert.equal(msg.to, "guest@example.com");
  assert.equal(msg.from, "TravelByChance <bookings@example.com>");
  assert.match(msg.subject, /Booking confirmed: Goa <b>Villa<\/b>/);
  assert.match(msg.text, /2 nights/);
  assert.match(msg.text, /Free cancellation until your check-in date/);
  assert.ok(msg.text.includes(`https://tbc.example/bookings/${res.body.booking.id}/plan`));
  assert.ok(msg.html.includes("Goa &lt;b&gt;Villa&lt;/b&gt;"), "listing title escaped in HTML");
  assert.ok(!msg.html.includes("<b>Villa</b>"));

  assert.deepEqual(await processEmailQueue(), { SENT: 0, RETRY: 0, GAVE_UP: 0, SKIPPED: 0 }, "never sent twice");
});

test("paid booking lifecycle: confirmed -> refund started -> refunded, one email each", async () => {
  const guest = await h.loginAgent(payApp, "guest");
  const b = await book(guest);
  assert.deepEqual(await events(), [], "a hold isn't emailed (the guest is paying right now)");
  const order = await guest.post(`/api/v1/bookings/${b.body.booking.id}/payment-order`);
  const paid = await guest.post(`/api/v1/demo-payments/${order.body.orderId}/pay`).send({ outcome: "success" });
  await guest.post("/api/v1/payments/verify").send(paid.body);
  await guest.post(`/api/v1/bookings/${b.body.booking.id}/cancel`);
  await processRefundQueue();
  assert.deepEqual(await events(), ["booking_confirmed", "refund_started", "refund_completed"]);

  await processEmailQueue();
  assert.deepEqual(sent.map((m) => m.subject.split(":")[0]), ["Booking confirmed", "Refund on its way", "Refund processed"]);
  assert.match(sent[0].text, /DEMO payment mode/, "demo mode is stated in the email");
});

test("an unpaid hold that expires gets one 'you weren't charged' email", async () => {
  const guest = await h.loginAgent(payApp, "guest");
  await book(guest);
  await expireStaleHolds({ now: later(20) });
  assert.deepEqual(await events(), ["hold_expired"]);
  await processEmailQueue();
  assert.match(sent[0].text, /You weren't charged/);
});

test("a change that rolls back sends no email (sold out)", async () => {
  await h.createUser("other");
  const guest = await h.loginAgent(instantApp, "guest");
  const other = await h.loginAgent(instantApp, "other");
  await book(guest);
  const second = await book(other); // same nights, 1 unit
  assert.equal(second.status, 409);
  assert.equal(await EmailOutbox.countDocuments(), 1, "only the booking that happened");
});

test("SMTP failures are retried with backoff, then given up", async () => {
  const guest = await h.loginAgent(instantApp, "guest");
  await book(guest);
  failNext = 1;
  assert.equal((await processEmailQueue()).RETRY, 1);
  let row = await EmailOutbox.findOne();
  assert.equal(row.status, "PENDING");
  assert.ok(row.nextAttemptAt > new Date(), "waits before retrying");
  assert.equal((await processEmailQueue()).SENT, 0, "not retried before its time");
  assert.equal((await processEmailQueue({ now: later(2) })).SENT, 1, "retry succeeds");

  // A second email that keeps failing gives up after MAX_ATTEMPTS.
  await Booking.updateOne({}, { $set: { status: "CONFIRMED" } });
  await EmailOutbox.create({ _id: "x:booking_cancelled", booking: row.booking, event: "booking_cancelled" });
  failNext = 99;
  for (let i = 0; i < MAX_ATTEMPTS; i++) await processEmailQueue({ now: later(200 * (i + 1)) });
  row = await EmailOutbox.findById("x:booking_cancelled");
  assert.equal(row.status, "GAVE_UP");
  assert.equal(row.attempts, MAX_ATTEMPTS);
});

test("without SMTP settings emails are skipped, not piled up", async () => {
  setMailTransport(null);
  const guest = await h.loginAgent(instantApp, "guest");
  await book(guest);
  assert.equal((await processEmailQueue()).SKIPPED, 1);
  assert.equal((await EmailOutbox.findOne()).status, "SKIPPED");
});

test("every event has a subject and the booking reference", () => {
  const booking = { _id: "65f0a1b2c3d4e5f6a7b8c9d0", checkIn: new Date("2026-11-05"), checkOut: new Date("2026-11-07"), nights: 2, amountPaise: 234000 };
  for (const event of EmailOutbox.EMAIL_EVENTS) {
    const m = buildEmail({ event, booking, listing: { _id: "l1", title: "Stay", location: "Goa" }, user: { username: "guest" }, publicUrl: "https://x" });
    assert.ok(m.subject.length > 5, event);
    assert.match(m.text, /Booking reference: A7B8C9D0/, event);
  }
});
