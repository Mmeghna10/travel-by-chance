// End-to-end payment flows through the real HTTP API and a simulated
// Razorpay (test/fakeRazorpay.js) with real HMAC signatures.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("../models/booking.js");
const Payment = require("../models/payment.js");
const Refund = require("../models/refund.js");
const WebhookEvent = require("../models/webhookEvent.js");
const InventoryNight = require("../models/inventoryNight.js");
const { configurePayments } = require("../modules/payments/gateway.js");
const { expireStaleHolds, confirmPayment } = require("../modules/bookings/lifecycle.js");
const { processRefundQueue, MAX_ATTEMPTS } = require("../modules/payments/refunds.js");
const { reconcilePayments } = require("../modules/payments/reconcile.js");
const { parseDay } = require("../modules/bookings/dates.js");
const { FakeRazorpay } = require("./fakeRazorpay.js");
const h = require("./helpers.js");

const KEY_SECRET = "test_key_secret_123";
const WEBHOOK_SECRET = "test_webhook_secret_456";
const later = (minutes) => new Date(Date.now() + minutes * 60 * 1000);

let app;
let rzp;
let host;
let agent;
let listing;

before(async () => {
  await h.startDb();
  app = h.buildApp({}, { requirePayment: true, holdMinutes: 15 });
});
after(h.stopDb);
beforeEach(async () => {
  await h.resetDb();
  rzp = new FakeRazorpay({ keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET });
  configurePayments({ keyId: "rzp_test_fake", keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, gateway: rzp });
  host = await h.createUser("host", "admin");
  await h.createUser("guest");
  listing = await h.createListing(host, { price: 1000, units: 1 });
  agent = await h.loginAgent(app, "guest");
});

async function holdBooking(who = agent, checkIn = h.day(10), checkOut = h.day(12)) {
  const res = await who
    .post("/api/v1/bookings")
    .set("Idempotency-Key", h.newKey())
    .send({ listingId: String(listing._id), checkIn, checkOut });
  assert.equal(res.status, 201);
  assert.equal(res.body.booking.status, "PENDING_PAYMENT");
  return res.body.booking.id;
}

async function order(bookingId, who = agent) {
  const res = await who.post(`/api/v1/bookings/${bookingId}/payment-order`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

// Sent as a string: supertest would JSON-encode a Buffer ({"type":"Buffer",...}),
// which (correctly) fails signature verification.
const sendWebhook = ({ body, headers }) =>
  h.request(app).post("/api/v1/webhooks/razorpay").set(headers).send(body.toString("utf8"));
const statusOf = async (id) => (await Booking.findById(id)).status;
const reservedOn = async (d) => (await InventoryNight.findOne({ listing: listing._id, date: parseDay(d) }))?.reserved ?? 0;

// ---------------------------------------------------------------- orders

test("payment order uses the server's amount and is reused on repeat calls", async () => {
  const id = await holdBooking();
  const first = await order(id);
  assert.equal(first.amount, 217000); // 2 nights x ₹1000 + 5% + 12% of one night, in paise
  assert.equal(first.currency, "INR");
  assert.equal(first.keyId, "rzp_test_fake");
  assert.equal(JSON.stringify(first).includes(KEY_SECRET), false, "secret never sent to the browser");
  assert.equal(rzp.orders.get(first.orderId).receipt, `bk_${id}`);

  const again = await order(id);
  assert.equal(again.orderId, first.orderId);
  assert.equal(rzp.calls.createOrder, 1);
});

test("ten simultaneous 'Pay' clicks create exactly one Razorpay order", async () => {
  const id = await holdBooking();
  const results = await Promise.all(Array.from({ length: 10 }, () => agent.post(`/api/v1/bookings/${id}/payment-order`)));
  assert.equal(rzp.calls.createOrder, 1);
  const ok = results.filter((r) => r.status === 200);
  assert.ok(ok.length >= 1);
  assert.equal(new Set(ok.map((r) => r.body.orderId)).size, 1);
  assert.ok(results.every((r) => r.status === 200 || r.body.code === "ORDER_IN_PROGRESS"));
  assert.equal(await Payment.countDocuments(), 1);
});

test("orders can't be created for someone else's, a paid, or an expired booking", async () => {
  const id = await holdBooking();
  await h.createUser("mallory");
  const mallory = await h.loginAgent(app, "mallory");
  assert.equal((await mallory.post(`/api/v1/bookings/${id}/payment-order`)).status, 404);

  await expireStaleHolds({ now: later(16) });
  const expired = await agent.post(`/api/v1/bookings/${id}/payment-order`);
  assert.equal(expired.status, 409);
  assert.equal(expired.body.code, "HOLD_EXPIRED");

  const id2 = await holdBooking(agent, h.day(20), h.day(21));
  await confirmPayment({ bookingId: id2 });
  assert.equal((await agent.post(`/api/v1/bookings/${id2}/payment-order`)).body.code, "ALREADY_PAID");
});

test("a Razorpay error becomes a 502 (not Razorpay's 401) and doesn't block a retry", async () => {
  const id = await holdBooking();
  rzp.failNext("createOrder", Object.assign(new Error("Authentication failed"), { statusCode: 401, error: { description: "Authentication failed" } }));
  const res = await agent.post(`/api/v1/bookings/${id}/payment-order`);
  assert.equal(res.status, 502);
  assert.equal(res.body.code, "PAYMENT_PROVIDER_ERROR");
  assert.equal(res.body.message, "The payment provider is unavailable. Please try again.");
  assert.ok(!JSON.stringify(res.body).includes("Authentication failed"), "provider details stay in the log");
  assert.equal(await Payment.countDocuments(), 0, "claim released");
  assert.equal((await agent.post(`/api/v1/bookings/${id}/payment-order`)).status, 200, "immediate retry works");
});

// ---------------------------------------------------------------- checkout verification

test("happy path: verified checkout confirms the booking", async () => {
  const id = await holdBooking();
  const o = await order(id);
  const paid = rzp.pay(o.orderId);

  const res = await agent.post("/api/v1/payments/verify").send(rzp.checkoutResponse(o.orderId, paid.id));
  assert.equal(res.status, 200);
  assert.equal(res.body.bookingStatus, "CONFIRMED");
  const payment = await Payment.findOne({ booking: id });
  assert.equal(payment.status, "CAPTURED");
  assert.equal(payment.capturedPaymentId, paid.id);
  assert.ok((await Booking.findById(id)).paidAt);
});

test("a forged or mismatched checkout signature confirms nothing", async () => {
  const id = await holdBooking();
  const o = await order(id);
  const paid = rzp.pay(o.orderId);
  const other = rzp.pay(o.orderId, { status: "failed" });

  const forged = [
    rzp.checkoutResponse(o.orderId, paid.id, "wrong-secret"), // not signed with our key secret
    { ...rzp.checkoutResponse(o.orderId, other.id), razorpay_payment_id: paid.id }, // signature for another payment
    { razorpay_order_id: o.orderId, razorpay_payment_id: paid.id, razorpay_signature: "deadbeef" },
    { razorpay_order_id: o.orderId, razorpay_payment_id: paid.id }, // no signature: "the browser says it worked"
  ];
  for (const body of forged) {
    const res = await agent.post("/api/v1/payments/verify").send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "SIGNATURE_INVALID");
  }
  assert.equal(await statusOf(id), "PENDING_PAYMENT");
});

test("a valid signature for a payment with the wrong amount does not confirm", async () => {
  const id = await holdBooking();
  const o = await order(id);
  const underpaid = rzp.pay(o.orderId, { amount: 100 }); // ₹1 instead of ₹2,170
  const res = await agent.post("/api/v1/payments/verify").send(rzp.checkoutResponse(o.orderId, underpaid.id));
  assert.equal(res.body.outcome, "IGNORED_MISMATCH");
  assert.equal(await statusOf(id), "PENDING_PAYMENT");
  const payment = await Payment.findOne({ booking: id });
  assert.match(payment.anomalies[0].reason, /amount mismatch/);
});

test("authorized-but-not-captured is not enough; the captured webhook confirms", async () => {
  const id = await holdBooking();
  const o = await order(id);
  const authorized = rzp.pay(o.orderId, { status: "authorized" });
  const res = await agent.post("/api/v1/payments/verify").send(rzp.checkoutResponse(o.orderId, authorized.id));
  assert.equal(res.body.outcome, "AUTHORIZED");
  assert.equal(await statusOf(id), "PENDING_PAYMENT");

  const captured = rzp.capture(authorized.id);
  const hook = await sendWebhook(rzp.webhook("payment.captured", { payment: captured }));
  assert.equal(hook.status, 200);
  assert.equal(await statusOf(id), "CONFIRMED");
});

// ---------------------------------------------------------------- webhooks

test("webhooks with a bad signature or re-serialised body are rejected and change nothing", async () => {
  const id = await holdBooking();
  const o = await order(id);
  const captured = rzp.pay(o.orderId);

  const forged = rzp.webhook("payment.captured", { payment: captured }, { secret: "attacker" });
  assert.equal((await sendWebhook(forged)).status, 400);

  const genuine = rzp.webhook("payment.captured", { payment: captured });
  const prettyPrinted = Buffer.from(JSON.stringify(JSON.parse(genuine.body.toString()), null, 2));
  assert.equal((await sendWebhook({ body: prettyPrinted, headers: genuine.headers })).status, 400);

  assert.equal(await statusOf(id), "PENDING_PAYMENT");
  assert.equal(await WebhookEvent.countDocuments(), 0, "rejected deliveries aren't even logged");
});

test("the same webhook delivered twice, and ten times at once, confirms once", async () => {
  const id = await holdBooking();
  const o = await order(id);
  const paid = rzp.pay(o.orderId);
  const delivery = rzp.webhook("payment.captured", { payment: paid });

  const first = await sendWebhook(delivery);
  const second = await sendWebhook(delivery);
  assert.equal(first.body.status, "PROCESSED");
  assert.equal(second.body.status, "DUPLICATE");

  // A different event id for the same fact (order.paid) and a burst of
  // concurrent duplicates: still one confirmation.
  const orderPaid = rzp.webhook("order.paid", { order: rzp.orders.get(o.orderId), payment: paid });
  await Promise.all(Array.from({ length: 10 }, () => sendWebhook(orderPaid)));

  const b = await Booking.findById(id);
  assert.equal(b.status, "CONFIRMED");
  assert.equal(b.statusHistory.filter((e) => e.to === "CONFIRMED").length, 1);
  assert.equal(await reservedOn(h.day(10)), 1);
  assert.equal((await WebhookEvent.findOne({ eventId: delivery.headers["x-razorpay-event-id"] })).deliveries, 2);
});

test("out-of-order events never move a payment backwards", async () => {
  const id = await holdBooking();
  const o = await order(id);
  const declined = rzp.pay(o.orderId, { status: "failed" }); // first attempt: card declined
  const success = rzp.pay(o.orderId); // retry in the same checkout: captured

  // Delivered in the "wrong" order: captured, then the older failure, then a stale authorized.
  await sendWebhook(rzp.webhook("payment.captured", { payment: success }));
  await sendWebhook(rzp.webhook("payment.failed", { payment: declined }));
  await sendWebhook(rzp.webhook("payment.authorized", { payment: { ...success, status: "authorized", captured: false } }));

  const payment = await Payment.findOne({ booking: id });
  assert.equal(payment.status, "CAPTURED");
  assert.equal(payment.capturedPaymentId, success.id);
  assert.equal(await statusOf(id), "CONFIRMED");
});

test("a failed attempt leaves the booking payable; a retry on the same order confirms", async () => {
  const id = await holdBooking();
  const o = await order(id);
  await sendWebhook(rzp.webhook("payment.failed", { payment: rzp.pay(o.orderId, { status: "failed" }) }));
  const p = await Payment.findOne({ booking: id });
  assert.equal(p.status, "FAILED");
  assert.match(p.lastFailureReason, /declined/);
  assert.equal(await statusOf(id), "PENDING_PAYMENT");
  assert.equal((await order(id)).orderId, o.orderId, "same order reused for the retry");

  const paid = rzp.pay(o.orderId);
  await agent.post("/api/v1/payments/verify").send(rzp.checkoutResponse(o.orderId, paid.id));
  assert.equal(await statusOf(id), "CONFIRMED");
});

test("webhooks for orders that aren't ours are acknowledged and ignored", async () => {
  const res = await sendWebhook(rzp.webhook("payment.captured", { payment: { id: "pay_x", order_id: "order_elsewhere", amount: 1, currency: "INR", status: "captured" } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.result, "UNKNOWN_ORDER");
});

// ---------------------------------------------------------------- late payments & refunds

test("late payment after expiry: re-held if free, refunded (via the outbox) if resold", async () => {
  // Free: confirmed late.
  const a = await holdBooking();
  const oa = await order(a);
  await expireStaleHolds({ now: later(16) });
  await sendWebhook(rzp.webhook("payment.captured", { payment: rzp.pay(oa.orderId) }));
  assert.equal(await statusOf(a), "CONFIRMED");

  // Resold: needs a refund.
  const b = await holdBooking(agent, h.day(20), h.day(22));
  const ob = await order(b);
  await expireStaleHolds({ now: later(16) });
  await h.createUser("other");
  const other = await h.loginAgent(app, "other");
  await holdBooking(other, h.day(21), h.day(23));
  await sendWebhook(rzp.webhook("payment.captured", { payment: rzp.pay(ob.orderId) }));

  assert.equal(await statusOf(b), "REFUND_PENDING");
  const refund = await Refund.findOne({ booking: b });
  assert.equal(refund.status, "REQUESTED", "queued in the same transaction as REFUND_PENDING");
  assert.equal(refund.amountPaise, 217000);

  await processRefundQueue();
  assert.equal(rzp.refunds.size, 1);
  assert.equal(await statusOf(b), "REFUNDED");
});

test("cancelling a paid booking: REFUNDED only once Razorpay confirms the refund", async () => {
  const id = await holdBooking();
  const o = await order(id);
  const paid = rzp.pay(o.orderId);
  await agent.post("/api/v1/payments/verify").send(rzp.checkoutResponse(o.orderId, paid.id));

  const cancel = await agent.post(`/api/v1/bookings/${id}/cancel`);
  assert.equal(cancel.body.booking.status, "REFUND_PENDING");
  assert.equal(await reservedOn(h.day(10)), 0, "dates released immediately");

  rzp.refundStatus = "pending"; // Razorpay accepts it but hasn't completed it
  await processRefundQueue();
  const refund = await Refund.findOne({ booking: id });
  assert.equal(refund.status, "PENDING");
  assert.equal(refund.paymentId, paid.id);
  assert.equal(await statusOf(id), "REFUND_PENDING", "not claimed as refunded yet");

  const processed = rzp.setRefundStatus(refund.razorpayRefundId, "processed");
  const delivery = rzp.webhook("refund.processed", { refund: processed, payment: rzp.payments.get(paid.id) });
  await sendWebhook(delivery);
  await sendWebhook(delivery); // duplicate
  assert.equal(await statusOf(id), "REFUNDED");
  assert.equal((await Booking.findById(id)).statusHistory.filter((e) => e.to === "REFUNDED").length, 1);
  assert.equal(rzp.calls.createRefund, 1);
});

test("refund crash recovery: response lost after Razorpay refunded -> adopted, not refunded twice", async () => {
  const id = await holdBooking();
  const o = await order(id);
  await sendWebhook(rzp.webhook("payment.captured", { payment: rzp.pay(o.orderId) }));
  await agent.post(`/api/v1/bookings/${id}/cancel`);

  rzp.loseResponseAfterRefund = true;
  const first = await processRefundQueue();
  assert.deepEqual(first, ["RETRY_SCHEDULED"]);
  assert.equal(rzp.refunds.size, 1, "Razorpay did refund");
  assert.equal(await statusOf(id), "REFUND_PENDING");

  const retry = await processRefundQueue({ now: later(5) }); // after the backoff
  assert.deepEqual(retry, ["PROCESSED"]);
  assert.equal(rzp.refunds.size, 1, "the existing refund was found by receipt and adopted");
  assert.equal(rzp.calls.createRefund, 1);
  assert.equal(await statusOf(id), "REFUNDED");
});

test("two refund workers at once submit the refund once", async () => {
  const id = await holdBooking();
  const o = await order(id);
  await sendWebhook(rzp.webhook("payment.captured", { payment: rzp.pay(o.orderId) }));
  await agent.post(`/api/v1/bookings/${id}/cancel`);

  // With real API latency, "look for an existing refund, then create one" is
  // itself a race: without the lease, every worker would see none and refund.
  rzp.latencyMs = 40;
  await Promise.all([processRefundQueue(), processRefundQueue(), processRefundQueue()]);
  assert.equal(rzp.calls.createRefund, 1);
  assert.equal(rzp.refunds.size, 1);
  assert.equal(await statusOf(id), "REFUNDED");
});

test("refund API errors back off and retry; after the limit the booking is REFUND_FAILED", async () => {
  const id = await holdBooking();
  const o = await order(id);
  await sendWebhook(rzp.webhook("payment.captured", { payment: rzp.pay(o.orderId) }));
  await agent.post(`/api/v1/bookings/${id}/cancel`);

  rzp.failNext("createRefund", Object.assign(new Error("Gateway timeout"), { statusCode: 504 }), 2);
  assert.deepEqual(await processRefundQueue(), ["RETRY_SCHEDULED"]);
  assert.deepEqual(await processRefundQueue(), [], "not retried before the backoff");
  assert.deepEqual(await processRefundQueue({ now: later(1) }), ["RETRY_SCHEDULED"]);
  assert.deepEqual(await processRefundQueue({ now: later(3) }), ["PROCESSED"], "third attempt succeeds");
  assert.equal(await statusOf(id), "REFUNDED");

  // Permanent failure: give up after MAX_ATTEMPTS and flag for a human.
  const id2 = await holdBooking(agent, h.day(30), h.day(31));
  const o2 = await order(id2);
  await sendWebhook(rzp.webhook("payment.captured", { payment: rzp.pay(o2.orderId) }));
  await agent.post(`/api/v1/bookings/${id2}/cancel`);
  rzp.failNext("createRefund", new Error("Refund not allowed"), MAX_ATTEMPTS + 1);
  for (let i = 0; i < MAX_ATTEMPTS; i++) await processRefundQueue({ now: later(120 * (i + 1)) });
  const refund = await Refund.findOne({ booking: id2 });
  assert.equal(refund.status, "FAILED");
  assert.equal(await statusOf(id2), "REFUND_FAILED");
});

test("refund.failed webhook marks the booking REFUND_FAILED", async () => {
  const id = await holdBooking();
  const o = await order(id);
  const paid = rzp.pay(o.orderId);
  await sendWebhook(rzp.webhook("payment.captured", { payment: paid }));
  await agent.post(`/api/v1/bookings/${id}/cancel`);
  rzp.refundStatus = "pending";
  await processRefundQueue();
  const refund = await Refund.findOne({ booking: id });
  await sendWebhook(rzp.webhook("refund.failed", { refund: rzp.setRefundStatus(refund.razorpayRefundId, "failed"), payment: paid }));
  assert.equal(await statusOf(id), "REFUND_FAILED");
});

// ---------------------------------------------------------------- reconciliation

test("reconciliation confirms a payment nobody told us about (tab closed, no webhook)", async () => {
  const id = await holdBooking();
  const o = await order(id);
  rzp.pay(o.orderId); // paid at Razorpay; no verify call, no webhook

  assert.equal((await reconcilePayments()).checked, 0, "waits a quiet period first");
  const summary = await reconcilePayments({ now: later(2) });
  assert.equal(summary.confirmed, 1);
  assert.equal(await statusOf(id), "CONFIRMED");
});

test("reconciliation finishes a crash between 'payment captured' and 'booking confirmed'", async () => {
  const id = await holdBooking();
  const o = await order(id);
  const paid = rzp.pay(o.orderId);
  // Simulate the crash: payment recorded as captured, confirm never ran.
  await Payment.updateOne({ booking: id }, { $set: { status: "CAPTURED", capturedPaymentId: paid.id } });
  assert.equal(await statusOf(id), "PENDING_PAYMENT");

  await reconcilePayments({ now: later(2) });
  assert.equal(await statusOf(id), "CONFIRMED");
});

test("reconciliation picks up a refund outcome whose webhook never arrived", async () => {
  const id = await holdBooking();
  const o = await order(id);
  await sendWebhook(rzp.webhook("payment.captured", { payment: rzp.pay(o.orderId) }));
  await agent.post(`/api/v1/bookings/${id}/cancel`);
  rzp.refundStatus = "pending";
  await processRefundQueue();
  const refund = await Refund.findOne({ booking: id });
  rzp.setRefundStatus(refund.razorpayRefundId, "processed");

  const summary = await reconcilePayments({ now: later(5) });
  assert.equal(summary.refundsChecked, 1);
  assert.equal(await statusOf(id), "REFUNDED");
});
