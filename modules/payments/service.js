// Payment use-cases. Three independent paths can tell us about a payment:
//   1. the browser, after Checkout succeeds (verifyCheckout)
//   2. Razorpay webhooks (webhooks.js)
//   3. the reconciliation job asking Razorpay directly (reconcile.js)
// They can arrive in any order, more than once, or not at all. All three end
// in applyGatewayPayment(), which is idempotent and never moves a payment
// backwards, so whichever arrives first wins and the others are no-ops.
const mongoose = require("mongoose");
const Booking = require("../../models/booking.js");
const Payment = require("../../models/payment.js");
const ExpressError = require("../../utils/ExpressError.js");
const { confirmPayment } = require("../bookings/lifecycle.js");
const { getGateway, getSettings } = require("./gateway.js");
const { verifyCheckoutSignature } = require("./signatures.js");
const { logger } = require("../observability/logger.js");
const { paymentOutcomes } = require("../observability/metrics.js");

const RANK = { CREATING: 0, CREATED: 1, FAILED: 1, AUTHORIZED: 2, CAPTURED: 3 };
const ranksBelow = (status) => Object.keys(RANK).filter((s) => RANK[s] < RANK[status]);
const CREATING_STALE_MS = 30 * 1000;

const notFound = () => new ExpressError(404, "Booking not found.", "BOOKING_NOT_FOUND");

// Razorpay being down or rejecting our credentials is a 502 for our client,
// not Razorpay's own status code. Details go to the log, not the browser.
function gatewayError(err) {
  const detail = (err.error && err.error.description) || err.message;
  logger.error({ providerStatus: err.statusCode, detail }, "Razorpay call failed");
  return new ExpressError(502, "The payment provider is unavailable. Please try again.", "PAYMENT_PROVIDER_ERROR");
}

function checkoutDetails(payment, booking, user) {
  return {
    keyId: getSettings().keyId,
    orderId: payment.orderId,
    amount: payment.amountPaise,
    currency: payment.currency,
    bookingId: String(booking._id),
    expiresAt: booking.expiresAt,
    prefill: { name: user.username, email: user.email },
  };
}

/**
 * Returns the Razorpay order to pay for a PENDING_PAYMENT booking, creating it
 * on first call. Repeated or concurrent calls return the same order.
 */
async function createPaymentOrder({ bookingId, user, now = new Date() }) {
  if (!mongoose.isValidObjectId(bookingId)) throw notFound();
  const booking = await Booking.findOne({ _id: bookingId, user: user._id });
  if (!booking) throw notFound();
  if (booking.status === "CONFIRMED") throw new ExpressError(409, "This booking is already paid.", "ALREADY_PAID");
  if (booking.status !== "PENDING_PAYMENT" || !booking.expiresAt || booking.expiresAt <= now) {
    throw new ExpressError(409, "This hold has expired. Please book again.", "HOLD_EXPIRED");
  }

  // Claim the single payment record for this booking. The amount comes from
  // the booking (priced by the server when it was created), never the client.
  const res = await Payment.findOneAndUpdate(
    { booking: booking._id },
    {
      $setOnInsert: {
        booking: booking._id,
        user: user._id,
        amountPaise: booking.amountPaise,
        currency: booking.currency,
        status: "CREATING",
        creatingSince: now,
      },
    },
    { upsert: true, new: true, includeResultMetadata: true },
  ).catch(async (err) => {
    // Two first requests raced on the unique index; the other one won.
    if (err.code === 11000) return { value: await Payment.findOne({ booking: booking._id }), lastErrorObject: {} };
    throw err;
  });
  let payment = res.value;
  const insertedByUs = Boolean(res.lastErrorObject && res.lastErrorObject.upserted);

  if (payment.status !== "CREATING") return checkoutDetails(payment, booking, user);

  if (!insertedByUs) {
    // Someone else is creating the order right now, or crashed while doing so.
    // Take over only if their claim is stale.
    const takeover = await Payment.findOneAndUpdate(
      { _id: payment._id, status: "CREATING", creatingSince: { $lt: new Date(now.getTime() - CREATING_STALE_MS) } },
      { $set: { creatingSince: now } },
      { new: true },
    );
    if (!takeover) throw new ExpressError(409, "Payment is being prepared. Please try again in a moment.", "ORDER_IN_PROGRESS");
    payment = takeover;
  }

  let order;
  try {
    order = await getGateway().createOrder({
      amount: payment.amountPaise,
      currency: payment.currency,
      receipt: `bk_${booking._id}`, // <= 40 chars
      notes: { bookingId: String(booking._id), userId: String(user._id) },
    });
  } catch (err) {
    // Release our claim so the customer can retry right away.
    await Payment.deleteOne({ _id: payment._id, status: "CREATING" });
    throw gatewayError(err);
  }
  if (order.amount !== payment.amountPaise || order.currency !== payment.currency) {
    throw new Error(`Razorpay order ${order.id} has unexpected amount/currency`);
  }

  payment = await Payment.findOneAndUpdate(
    { _id: payment._id, status: "CREATING" },
    { $set: { orderId: order.id, status: "CREATED" }, $unset: { creatingSince: "" } },
    { new: true },
  );
  if (!payment) throw new ExpressError(409, "Payment is being prepared. Please try again in a moment.", "ORDER_IN_PROGRESS");
  return checkoutDetails(payment, booking, user);
}

/**
 * Applies a Razorpay payment entity (from the API or a signed webhook) to our
 * records. Checks it really belongs to this order with the expected amount
 * and currency before acting. Returns a short outcome string.
 */
async function applyGatewayPayment(payment, entity, { now = new Date(), source = "unknown" } = {}) {
  const outcome = await applyGatewayPaymentInner(payment, entity, { now });
  paymentOutcomes.inc({ source, outcome });
  logger.info(
    { bookingId: String(payment.booking), orderId: payment.orderId, paymentId: entity.id, status: entity.status, source, outcome },
    "payment applied",
  );
  return outcome;
}

async function applyGatewayPaymentInner(payment, entity, { now }) {
  const mismatch =
    entity.order_id !== payment.orderId
      ? "order_id"
      : entity.amount !== payment.amountPaise
        ? "amount"
        : entity.currency !== payment.currency
          ? "currency"
          : null;
  if (mismatch) {
    await Payment.updateOne(
      { _id: payment._id },
      { $push: { anomalies: { at: now, paymentId: entity.id, reason: `${mismatch} mismatch (status ${entity.status})` } } },
    );
    logger.error({ orderId: payment.orderId, paymentId: entity.id, mismatch }, "ignored payment: mismatch");
    return "IGNORED_MISMATCH";
  }

  switch (entity.status) {
    case "captured":
    case "refunded": {
      // "refunded" means it WAS captured (and later refunded by us); the
      // booking side of that is handled by the refund flow.
      const res = await Payment.updateOne(
        { _id: payment._id, status: { $in: ranksBelow("CAPTURED") } },
        { $set: { status: "CAPTURED", capturedPaymentId: entity.id, lastPaymentId: entity.id } },
      );
      if (res.modifiedCount === 0) {
        const current = await Payment.findById(payment._id);
        if (current.capturedPaymentId && current.capturedPaymentId !== entity.id) {
          // A second, different captured payment for the same order: money we
          // didn't expect. Don't treat it as a duplicate event; flag it.
          await Payment.updateOne(
            { _id: payment._id },
            { $push: { anomalies: { at: now, paymentId: entity.id, reason: "second captured payment on order" } } },
          );
          logger.error({ orderId: payment.orderId, paymentId: entity.id }, "second captured payment on order");
          return "DUPLICATE_CAPTURE";
        }
      }
      // Always called, even if the payment was already CAPTURED: if we crashed
      // after saving CAPTURED but before confirming, this finishes the job.
      // confirmPayment() is idempotent.
      const { outcome } = await confirmPayment({ bookingId: payment.booking, now });
      return outcome;
    }
    case "authorized":
      await Payment.updateOne(
        { _id: payment._id, status: { $in: ranksBelow("AUTHORIZED") } },
        { $set: { status: "AUTHORIZED", lastPaymentId: entity.id } },
      );
      return "AUTHORIZED"; // auto-capture will follow; the booking waits for it
    case "failed":
      // Only from CREATED/FAILED: a failed attempt must never override an
      // authorized/captured one (they can arrive out of order).
      await Payment.updateOne(
        { _id: payment._id, status: { $in: ["CREATED", "FAILED"] } },
        {
          $set: {
            status: "FAILED",
            lastPaymentId: entity.id,
            lastFailureReason: entity.error_description || entity.error_code || "failed",
          },
        },
      );
      return "FAILED";
    default:
      return "NO_CHANGE"; // "created": nothing has happened yet
  }
}

/**
 * Called with the Checkout handler's response. The signature proves Razorpay
 * issued this payment id for OUR order; we then fetch the payment from the
 * API to learn its real status. A browser saying "success" is never enough.
 */
async function verifyCheckout({ user, orderId, paymentId, signature }) {
  const payment = typeof orderId === "string" ? await Payment.findOne({ orderId, user: user._id }) : null;
  if (!payment) throw notFound();

  const valid = verifyCheckoutSignature({
    orderId: payment.orderId, // ours, not the client's copy
    paymentId,
    signature,
    keySecret: getSettings().keySecret,
  });
  if (!valid) {
    logger.warn({ orderId: payment.orderId }, "invalid checkout signature");
    throw new ExpressError(400, "Payment verification failed.", "SIGNATURE_INVALID");
  }

  const entity = await getGateway().fetchPayment(paymentId).catch((err) => {
    throw gatewayError(err);
  });
  const outcome = await applyGatewayPayment(payment, entity, { source: "verify" });
  const booking = await Booking.findById(payment.booking);
  return { outcome, bookingId: String(booking._id), bookingStatus: booking.status };
}

module.exports = { createPaymentOrder, verifyCheckout, applyGatewayPayment, RANK };
