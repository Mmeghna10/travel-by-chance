// Refund worker: sends queued refunds (the outbox rows created by the
// REFUND_PENDING transition) to Razorpay, and applies refund outcomes.
//
// The booking only becomes REFUNDED when Razorpay says the refund is
// "processed". Until then it stays REFUND_PENDING, however long that takes.
const mongoose = require("mongoose");
const Booking = require("../../models/booking.js");
const Payment = require("../../models/payment.js");
const Refund = require("../../models/refund.js");
const { applyTransition } = require("../bookings/stateMachine.js");
const { getGateway } = require("./gateway.js");
const { logger } = require("../observability/logger.js");
const { refundOutcomes } = require("../observability/metrics.js");

function recordRefund(refund, outcome, extra = {}) {
  refundOutcomes.inc({ outcome: outcome.toLowerCase() });
  logger.info({ bookingId: String(refund.booking), outcome, ...extra }, "refund update");
  return outcome;
}

const LEASE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const backoffMs = (attempts) => Math.min(60 * 60 * 1000, 30 * 1000 * 2 ** (attempts - 1)); // 30s, 1m, 2m, ... max 1h

async function moveBooking(bookingId, from, to, reason) {
  return mongoose.connection.transaction(async (session) => {
    const booking = await Booking.findById(bookingId).session(session);
    if (!booking || booking.status !== from) return false;
    return applyTransition({ booking, from, to, actor: "payment", session, reason });
  });
}

/** Applies a Razorpay refund entity (from the API or a signed webhook). Idempotent. */
async function applyGatewayRefund(refund, entity, { now = new Date() } = {}) {
  if (entity.status === "processed") {
    await Refund.updateOne(
      { _id: refund._id, status: { $nin: ["PROCESSED"] } },
      { $set: { status: "PROCESSED", razorpayRefundId: entity.id, processedAt: now }, $unset: { lockedUntil: "" } },
    );
    await moveBooking(refund.booking, "REFUND_PENDING", "REFUNDED", "refund processed by Razorpay");
    return recordRefund(refund, "PROCESSED", { refundId: entity.id });
  }
  if (entity.status === "failed") {
    await Refund.updateOne(
      { _id: refund._id, status: { $nin: ["PROCESSED", "FAILED"] } },
      { $set: { status: "FAILED", razorpayRefundId: entity.id, lastError: "Razorpay reported refund failure" }, $unset: { lockedUntil: "" } },
    );
    await moveBooking(refund.booking, "REFUND_PENDING", "REFUND_FAILED", "Razorpay reported refund failure");
    return recordRefund(refund, "FAILED", { refundId: entity.id });
  }
  // "pending" (or anything not final): accepted, waiting for the outcome.
  await Refund.updateOne(
    { _id: refund._id, status: { $in: ["REQUESTED", "SUBMITTING"] } },
    { $set: { status: "PENDING", razorpayRefundId: entity.id }, $unset: { lockedUntil: "" } },
  );
  return recordRefund(refund, "PENDING", { refundId: entity.id });
}

async function giveUp(refund, error) {
  await Refund.updateOne(
    { _id: refund._id, status: "SUBMITTING" },
    { $set: { status: "FAILED", lastError: error }, $unset: { lockedUntil: "" } },
  );
  await moveBooking(refund.booking, "REFUND_PENDING", "REFUND_FAILED", error);
  // Dead-lettered: a human has to look at this one.
  logger.error({ bookingId: String(refund.booking), error }, "refund gave up");
  return recordRefund(refund, "GAVE_UP");
}

/** Submits one refund. Safe if two workers run it at once (lease) or after a crash (receipt lookup). */
async function submitRefund(refund) {
  const payment = await Payment.findOne({ booking: refund.booking, status: "CAPTURED" });
  if (!payment || !payment.capturedPaymentId) {
    return giveUp(refund, "No captured Razorpay payment found for this booking");
  }
  const gateway = getGateway();
  try {
    // Crash recovery: if a previous attempt reached Razorpay but we crashed
    // (or timed out) before saving the result, the refund already exists.
    // Adopt it instead of refunding the customer twice.
    const existing = (await gateway.fetchRefunds(payment.capturedPaymentId)).find((r) => r.receipt === refund.receipt);
    const entity =
      existing ||
      (await gateway.createRefund(payment.capturedPaymentId, {
        amount: refund.amountPaise,
        speed: "normal",
        receipt: refund.receipt,
        notes: { bookingId: String(refund.booking) },
      }));
    await Refund.updateOne({ _id: refund._id }, { $set: { paymentId: payment.capturedPaymentId } });
    return applyGatewayRefund(refund, entity);
  } catch (err) {
    const message = (err.error && err.error.description) || err.message || "unknown error";
    if (refund.attempts >= MAX_ATTEMPTS) return giveUp(refund, `Gave up after ${refund.attempts} attempts: ${message}`);
    // Back to the queue with exponential backoff: transient errors (network,
    // Razorpay 5xx) get retried without hammering the API.
    await Refund.updateOne(
      { _id: refund._id, status: "SUBMITTING" },
      {
        $set: { status: "REQUESTED", lastError: message, nextAttemptAt: new Date(Date.now() + backoffMs(refund.attempts)) },
        $unset: { lockedUntil: "" },
      },
    );
    return recordRefund(refund, "RETRY_SCHEDULED", { error: message, attempts: refund.attempts });
  }
}

/** One worker pass: claim due refunds one at a time and submit them. */
async function processRefundQueue({ now = new Date(), limit = 20 } = {}) {
  const results = [];
  for (let i = 0; i < limit; i++) {
    // Claim = atomic status change with a lease. Two workers can't claim the
    // same row; a worker that dies mid-call leaves a lease that expires, and
    // the row is picked up again (the receipt lookup prevents a double refund).
    const refund = await Refund.findOneAndUpdate(
      {
        $or: [
          { status: "REQUESTED", $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }] },
          { status: "SUBMITTING", lockedUntil: { $lte: now } },
        ],
      },
      { $set: { status: "SUBMITTING", lockedUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
      { new: true, sort: { createdAt: 1 } },
    );
    if (!refund) break;
    results.push(await submitRefund(refund));
  }
  return results;
}

module.exports = { processRefundQueue, applyGatewayRefund, MAX_ATTEMPTS };
