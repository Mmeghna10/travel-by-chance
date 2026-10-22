// The booking lifecycle as data. Every status change in the app goes through
// applyTransition(), which (1) refuses transitions not in this table, and
// (2) applies the change with a GUARDED update:
//
//   updateOne({ _id, status: <expected from-state> }, { $set: { status: <to> } })
//
// If two actors race (expiry vs payment, cancel vs payment, two workers), only
// the one whose expected from-state is still current changes anything. The
// other sees modifiedCount 0 and does nothing, so its side effects (like
// releasing inventory) don't happen twice.
const Booking = require("../../models/booking.js");
const Listing = require("../../models/listing.js");
const Refund = require("../../models/refund.js");
const ExpressError = require("../../utils/ExpressError.js");
const { nightsBetween } = require("./dates.js");
const { ensureNights, reserveNights, releaseNights } = require("./inventory.js");
const { logger } = require("../observability/logger.js");
const { bookingTransitions } = require("../observability/metrics.js");

// Who may cause each transition:
//   guest   - the user who made the booking (cancel)
//   system  - the expiry worker
//   payment - a verified payment/refund outcome (Milestone 4 calls these)
const TRANSITIONS = {
  PENDING_PAYMENT: {
    CONFIRMED: ["payment"], // payment captured in time
    EXPIRED: ["system"], // hold ran out unpaid
    CANCELLED: ["guest"], // guest gave up before paying
  },
  CONFIRMED: {
    CANCELLED: ["guest"], // cancelled, nothing was paid (payments disabled)
    REFUND_PENDING: ["guest"], // cancelled after paying
  },
  EXPIRED: {
    CONFIRMED: ["payment"], // late payment, and the nights could be re-held
    REFUND_PENDING: ["payment"], // late payment, but the nights were taken
  },
  CANCELLED: {
    REFUND_PENDING: ["payment"], // payment landed after the guest cancelled
  },
  REFUND_PENDING: {
    REFUNDED: ["payment"],
    REFUND_FAILED: ["payment"],
  },
  REFUND_FAILED: {},
  REFUNDED: {},
};

// Statuses whose nights are counted in InventoryNight.reserved.
const HOLDS_INVENTORY = new Set(["PENDING_PAYMENT", "CONFIRMED"]);

function canTransition(from, to, actor) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from][to] && TRANSITIONS[from][to].includes(actor));
}

// "release" | "reserve" | "none": what a transition does to inventory.
function inventoryEffect(from, to) {
  const before = HOLDS_INVENTORY.has(from);
  const after = HOLDS_INVENTORY.has(to);
  if (before && !after) return "release";
  if (!before && after) return "reserve";
  return "none";
}

/**
 * Moves `booking` from `from` to `to` inside `session`'s transaction and
 * applies the inventory effect. Returns true if this call made the change,
 * false if the booking was no longer in `from` (someone else got there first).
 * Throws SOLD_OUT if a "reserve" transition finds a night full; the caller's
 * transaction then rolls back, including the status change.
 */
async function applyTransition({ booking, from, to, actor, session, set = {}, reason, now = new Date() }) {
  if (!canTransition(from, to, actor)) {
    throw new ExpressError(409, `A booking can't go from ${from} to ${to}.`, "INVALID_TRANSITION");
  }

  const res = await Booking.updateOne(
    { _id: booking._id, status: from },
    {
      $set: { status: to, ...set },
      $push: { statusHistory: { from, to, actor, at: now, reason } },
    },
    { session },
  );
  if (res.modifiedCount !== 1) return false;

  // Transactional outbox: the refund request is written in the same
  // transaction as the status change, so a booking can't be committed as
  // "needs a refund" without the refund being queued (and vice versa).
  if (to === "REFUND_PENDING") {
    await Refund.updateOne(
      { booking: booking._id },
      { $setOnInsert: { booking: booking._id, amountPaise: booking.amountPaise, receipt: `rf_${booking._id}`, status: "REQUESTED" } },
      { upsert: true, session },
    );
  }

  const effect = inventoryEffect(from, to);
  if (effect !== "none") {
    const nights = nightsBetween(booking.checkIn, booking.checkOut);
    if (effect === "release") {
      await releaseNights(booking.listing, nights, session);
    } else {
      const listing = await Listing.findById(booking.listing).select("units").session(session);
      if (!listing) throw new ExpressError(409, "The listing no longer exists.", "SOLD_OUT");
      await reserveNights(booking.listing, nights, listing.units, session);
    }
  }
  // Counted when applied inside the transaction; an attempt that is rolled back
  // and retried by the driver can therefore be counted more than once.
  bookingTransitions.inc({ from, to, actor });
  logger.info({ bookingId: String(booking._id), from, to, actor, reason }, "booking transition");
  return true;
}

// Counters must exist before a "reserve" transition (see inventory.js).
async function prepareReserve(booking) {
  await ensureNights(booking.listing, nightsBetween(booking.checkIn, booking.checkOut));
}

module.exports = { TRANSITIONS, HOLDS_INVENTORY, canTransition, inventoryEffect, applyTransition, prepareReserve };
