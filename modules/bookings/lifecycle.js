// Everything that happens to a booking after it is created: payment
// confirmation, cancellation and expiry. Each use-case runs in a transaction
// and changes status only through stateMachine.applyTransition().
const mongoose = require("mongoose");
const Booking = require("../../models/booking.js");
const ExpressError = require("../../utils/ExpressError.js");
const { todayIn } = require("./dates.js");
const { applyTransition, prepareReserve } = require("./stateMachine.js");
const { reportError } = require("../observability/errors.js");

const withTransaction = (fn) => mongoose.connection.transaction(fn);

// ---------------------------------------------------------------------------
// Payment confirmation (Milestone 4's verified payment/webhook handler calls this)
// ---------------------------------------------------------------------------

/**
 * Records that the booking has been PAID and decides what that means given
 * whatever happened to the booking in the meantime. Safe to call any number
 * of times (duplicate webhooks): repeated calls return a "no change" outcome.
 *
 * Outcomes:
 *   CONFIRMED           paid while the hold was still active
 *   CONFIRMED_LATE      paid after expiry, nights were still free and got re-held
 *   REFUND_REQUIRED     paid after expiry/cancellation and the stay can't be honoured
 *   ALREADY_CONFIRMED   duplicate: was already confirmed
 *   ALREADY_HANDLED     duplicate: already in a refund state
 */
async function confirmPayment({ bookingId, now = new Date() }) {
  const booking = await Booking.findById(bookingId);
  if (!booking) throw new ExpressError(404, "Booking not found.", "BOOKING_NOT_FOUND");
  if (booking.status === "EXPIRED") await prepareReserve(booking);

  try {
    return await withTransaction(async (session) => {
      // Re-read inside the transaction: the status may have changed since.
      const current = await Booking.findById(bookingId).session(session);
      const move = (from, to, reason) =>
        applyTransition({ booking: current, from, to, actor: "payment", session, now, reason, set: { paidAt: now } });

      switch (current.status) {
        case "PENDING_PAYMENT":
          await move("PENDING_PAYMENT", "CONFIRMED", "payment captured");
          return { outcome: "CONFIRMED" };
        case "EXPIRED":
          // Throws SOLD_OUT (rolling this transaction back) if a night was resold.
          await move("EXPIRED", "CONFIRMED", "late payment, nights re-held");
          return { outcome: "CONFIRMED_LATE" };
        case "CANCELLED":
          await move("CANCELLED", "REFUND_PENDING", "payment after cancellation");
          return { outcome: "REFUND_REQUIRED" };
        case "CONFIRMED":
          return { outcome: "ALREADY_CONFIRMED" };
        default:
          return { outcome: "ALREADY_HANDLED" };
      }
    });
  } catch (err) {
    if (err.code !== "SOLD_OUT") throw err;
    // Paid after expiry and someone else now has the nights. We hold the
    // guest's money for a stay we can't provide: it must be refunded.
    return withTransaction(async (session) => {
      const current = await Booking.findById(bookingId).session(session);
      if (current.status !== "EXPIRED") return { outcome: "ALREADY_HANDLED" };
      await applyTransition({
        booking: current,
        from: "EXPIRED",
        to: "REFUND_PENDING",
        actor: "payment",
        session,
        now,
        reason: "late payment, nights no longer available",
        set: { paidAt: now },
      });
      return { outcome: "REFUND_REQUIRED" };
    });
  }
}

// ---------------------------------------------------------------------------
// Cancellation by the guest
// ---------------------------------------------------------------------------

const CANCELLED_STATES = new Set(["CANCELLED", "REFUND_PENDING", "REFUNDED", "REFUND_FAILED"]);

/**
 * Cancels the user's own booking. Unpaid -> CANCELLED; paid -> REFUND_PENDING
 * (Milestone 4 issues the refund). Either way the nights are released.
 * Cancelling an already-cancelled booking returns it unchanged.
 */
async function cancelBooking({ bookingId, userId, now = new Date() }) {
  // Object-level authorization: the query includes the owner, so another
  // user's booking id behaves exactly like a non-existent one (404, no leak).
  const notFound = () => new ExpressError(404, "Booking not found.", "BOOKING_NOT_FOUND");
  if (!mongoose.isValidObjectId(bookingId)) throw notFound();

  return withTransaction(async (session) => {
    const booking = await Booking.findOne({ _id: bookingId, user: userId }).session(session);
    if (!booking) throw notFound();

    // Already cancelled or refunding: cancelling again is a no-op, not an error.
    if (CANCELLED_STATES.has(booking.status)) {
      return { booking, changed: false };
    }
    if (booking.checkIn <= todayIn(undefined, now)) {
      throw new ExpressError(409, "This stay has already started and can no longer be cancelled.", "CANCELLATION_CLOSED");
    }

    const to = booking.status === "CONFIRMED" && booking.paidAt ? "REFUND_PENDING" : "CANCELLED";
    const changed = await applyTransition({
      booking,
      from: booking.status,
      to,
      actor: "guest",
      session,
      now,
      reason: "cancelled by guest",
      set: { cancelledAt: now },
    });
    // Inside a transaction a concurrent change surfaces as a WriteConflict
    // (and the driver retries with fresh data), so this is a defensive check.
    if (!changed) throw new ExpressError(409, "The booking changed while cancelling. Please retry.", "CONCURRENT_UPDATE");
    return { booking: await Booking.findById(bookingId).session(session), changed: true };
  });
}

// ---------------------------------------------------------------------------
// Expiry of unpaid holds (run by the worker)
// ---------------------------------------------------------------------------

/**
 * Expires PENDING_PAYMENT bookings whose hold ran out and releases their
 * nights. Safe to run concurrently in several processes and to re-run after
 * a crash: each booking is expired by a guarded transition in its own
 * transaction, so it happens at most once and never half-way.
 */
async function expireStaleHolds({ now = new Date(), limit = 100 } = {}) {
  const candidates = await Booking.find({ status: "PENDING_PAYMENT", expiresAt: { $lte: now } })
    .select("_id")
    .sort({ expiresAt: 1 })
    .limit(limit)
    .lean();

  let expired = 0;
  let skipped = 0;
  for (const { _id } of candidates) {
    try {
      const changed = await withTransaction(async (session) => {
        // Re-check inside the transaction: it may have been paid or cancelled
        // (or expired by another worker) since the query above.
        const booking = await Booking.findOne({ _id, status: "PENDING_PAYMENT", expiresAt: { $lte: now } }).session(session);
        if (!booking) return false;
        return applyTransition({ booking, from: "PENDING_PAYMENT", to: "EXPIRED", actor: "system", session, now, reason: "hold expired" });
      });
      changed ? expired++ : skipped++;
    } catch (err) {
      // One bad booking must not stop the rest; it stays PENDING_PAYMENT and
      // is retried on the next run.
      reportError(err, { message: "expiry failed", bookingId: String(_id) });
      skipped++;
    }
  }
  return { expired, skipped, scanned: candidates.length };
}

module.exports = { confirmPayment, cancelBooking, expireStaleHolds };
