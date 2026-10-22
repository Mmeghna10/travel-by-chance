// Demo payment mode: the simulated gateway must drive the REAL payment code
// (signature check, captured + amount check, guarded confirmation, refunds,
// reconciliation), and must be impossible to enable by accident.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("../models/booking.js");
const Payment = require("../models/payment.js");
const { configurePayments, validateDemo } = require("../modules/payments/gateway.js");
const { DemoRecord } = require("../modules/payments/demoGateway.js");
const { processRefundQueue } = require("../modules/payments/refunds.js");
const { reconcilePayments } = require("../modules/payments/reconcile.js");
const { FakeRazorpay } = require("./fakeRazorpay.js");
const h = require("./helpers.js");

const later = (minutes) => new Date(Date.now() + minutes * 60 * 1000);

let app;
let host;
let listing;
let agent;
before(async () => {
  await h.startDb();
  app = h.buildApp({}, { requirePayment: true, holdMinutes: 15 });
});
after(h.stopDb);
beforeEach(async () => {
  await h.resetDb();
  configurePayments({ demo: true, demoSecret: "test-app-secret" });
  host = await h.createUser("host", "admin");
  await h.createUser("guest");
  listing = await h.createListing(host, { price: 1000, units: 1 });
  agent = await h.loginAgent(app, "guest");
});

async function holdAndOrder(who = agent) {
  const b = await who
    .post("/api/v1/bookings")
    .set("Idempotency-Key", h.newKey())
    .send({ listingId: String(listing._id), checkIn: h.day(10), checkOut: h.day(12) });
  assert.equal(b.body.booking.status, "PENDING_PAYMENT");
  const o = await who.post(`/api/v1/bookings/${b.body.booking.id}/payment-order`);
  assert.equal(o.status, 200);
  return { bookingId: b.body.booking.id, order: o.body };
}
const statusOf = async (id) => (await Booking.findById(id)).status;

test("demo success: simulated checkout -> real /payments/verify -> booking CONFIRMED", async () => {
  const { bookingId, order } = await holdAndOrder();
  assert.equal(order.mode, "demo");
  assert.match(order.orderId, /^order_demo_/);

  const paid = await agent.post(`/api/v1/demo-payments/${order.orderId}/pay`).send({ outcome: "success" });
  assert.equal(paid.status, 200);
  assert.match(paid.body.razorpay_payment_id, /^pay_demo_/);
  assert.equal(await statusOf(bookingId), "PENDING_PAYMENT", "the demo endpoint itself confirms nothing");

  const verified = await agent.post("/api/v1/payments/verify").send(paid.body);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.bookingStatus, "CONFIRMED");
  assert.equal((await Payment.findOne({ booking: bookingId })).status, "CAPTURED");
});

test("a tampered demo signature is rejected by the real verification path", async () => {
  const { bookingId, order } = await holdAndOrder();
  const paid = await agent.post(`/api/v1/demo-payments/${order.orderId}/pay`).send({ outcome: "success" });
  const forged = { ...paid.body, razorpay_signature: paid.body.razorpay_signature.replace(/.$/, (c) => (c === "0" ? "1" : "0")) };
  const res = await agent.post("/api/v1/payments/verify").send(forged);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "SIGNATURE_INVALID");
  assert.equal(await statusOf(bookingId), "PENDING_PAYMENT");
});

test("demo decline keeps the hold; retrying on the same order then succeeds", async () => {
  const { bookingId, order } = await holdAndOrder();
  const declined = await agent.post(`/api/v1/demo-payments/${order.orderId}/pay`).send({ outcome: "declined" });
  assert.equal(declined.status, 402);
  assert.equal(declined.body.code, "DEMO_DECLINED");
  assert.equal(await statusOf(bookingId), "PENDING_PAYMENT");

  const retry = await agent.post(`/api/v1/demo-payments/${order.orderId}/pay`).send({ outcome: "success" });
  await agent.post("/api/v1/payments/verify").send(retry.body);
  assert.equal(await statusOf(bookingId), "CONFIRMED");
});

test("'pay, then close the window': reconciliation confirms it without the browser", async () => {
  const { bookingId, order } = await holdAndOrder();
  await agent.post(`/api/v1/demo-payments/${order.orderId}/pay`).send({ outcome: "success" });
  assert.equal(await statusOf(bookingId), "PENDING_PAYMENT");

  const summary = await reconcilePayments({ now: later(2) });
  assert.equal(summary.confirmed, 1);
  assert.equal(await statusOf(bookingId), "CONFIRMED");
});

test("cancelling a demo-paid booking refunds it through the real refund worker", async () => {
  const { bookingId, order } = await holdAndOrder();
  const paid = await agent.post(`/api/v1/demo-payments/${order.orderId}/pay`).send({ outcome: "success" });
  await agent.post("/api/v1/payments/verify").send(paid.body);

  const cancel = await agent.post(`/api/v1/bookings/${bookingId}/cancel`);
  assert.equal(cancel.body.booking.status, "REFUND_PENDING");
  assert.deepEqual(await processRefundQueue(), ["PROCESSED"]);
  assert.equal(await statusOf(bookingId), "REFUNDED");
  assert.equal(await DemoRecord.countDocuments({ kind: "refund" }), 1, "exactly one simulated refund");
});

test("only the booking's owner can 'pay' its demo order", async () => {
  const { order } = await holdAndOrder();
  await h.createUser("mallory");
  const mallory = await h.loginAgent(app, "mallory");
  const res = await mallory.post(`/api/v1/demo-payments/${order.orderId}/pay`).send({ outcome: "success" });
  assert.equal(res.status, 404);
  assert.equal(await DemoRecord.countDocuments({ kind: "payment" }), 0);
  assert.equal((await h.request(app).post(`/api/v1/demo-payments/${order.orderId}/pay`)).status, 401);
});

test("the listing page labels demo mode and doesn't load Razorpay's script", async () => {
  const page = await h.request(app).get(`/listings/${listing._id}`);
  assert.ok(page.text.includes("DEMO payment"));
  assert.ok(!page.text.includes("checkout.razorpay.com/v1/checkout.js"));
});

test("the demo endpoint doesn't exist outside demo mode", async () => {
  const { order } = await holdAndOrder();
  // Switch to (simulated) real Razorpay: the demo endpoint must disappear.
  configurePayments({ keyId: "rzp_test_x", keySecret: "s", gateway: new FakeRazorpay({ keySecret: "s" }) });
  const res = await agent.post(`/api/v1/demo-payments/${order.orderId}/pay`).send({ outcome: "success" });
  assert.equal(res.status, 404);
});

test("demo mode can't be enabled by accident", () => {
  assert.throws(() => validateDemo({ demo: true, keyId: "rzp_test_abc" }), /choose one/);
  assert.throws(() => validateDemo({ demo: true, isProduction: true }), /refused when NODE_ENV=production/);
  assert.doesNotThrow(() => validateDemo({ demo: true, isProduction: true, allowDemoInProduction: true }));
  assert.doesNotThrow(() => validateDemo({ demo: false, keyId: "rzp_test_abc", isProduction: true }));
  assert.throws(() => configurePayments({ demo: true }), /need a secret/);
});
