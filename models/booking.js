const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// A booking gets its initial status when it is created. Every later change
// must go through modules/bookings/stateMachine.js (guarded + audited).
const BOOKING_STATUSES = [
  "PENDING_PAYMENT",
  "CONFIRMED",
  "EXPIRED",
  "CANCELLED",
  "REFUND_PENDING",
  "REFUNDED",
  "REFUND_FAILED",
];
// Statuses whose nights are counted in InventoryNight.reserved.
const ACTIVE_STATUSES = ["PENDING_PAYMENT", "CONFIRMED"];

// Audit trail: every transition appends one entry, written in the same
// update as the status change, so it can't drift from the real history.
const statusHistorySchema = new Schema(
  {
    from: String,
    to: String,
    actor: { type: String, enum: ["guest", "system", "payment"] },
    at: Date,
    reason: String,
  },
  { _id: false },
);

const priceBreakdownSchema = new Schema(
  {
    nightlyPaise: Number,
    subtotalPaise: Number,
    cleaningFeePaise: Number,
    serviceFeePaise: Number,
  },
  { _id: false },
);

const bookingSchema = new Schema({
  listing: {
    type: Schema.Types.ObjectId,
    ref: "Listing",
    required: true,
  },
  user: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  checkIn: {
    type: Date,
    required: true,
  },
  checkOut: {
    type: Date,
    required: true,
  },
  // Not required so bookings created before Milestone 2 still load; the
  // migration script (init/migrate-bookings.js) fills it in.
  status: {
    type: String,
    enum: BOOKING_STATUSES,
  },
  nights: Number,
  // PENDING_PAYMENT holds inventory only until this time; the expiry worker
  // then moves it to EXPIRED and releases the nights.
  expiresAt: Date,
  paidAt: Date,
  cancelledAt: Date,
  statusHistory: { type: [statusHistorySchema], default: undefined },
  currency: { type: String, default: "INR" },
  amountPaise: Number,
  priceBreakdown: priceBreakdownSchema,
  // Rupees, kept for the existing views and admin dashboard.
  totalPrice: {
    type: Number,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

bookingSchema.index({ user: 1, createdAt: -1 }); // "My bookings"
bookingSchema.index({ listing: 1, checkOut: 1 }); // active bookings of a listing
bookingSchema.index({ status: 1, expiresAt: 1 }); // expiry worker: stale holds

const Booking = mongoose.model("Booking", bookingSchema);
module.exports = Booking;
module.exports.BOOKING_STATUSES = BOOKING_STATUSES;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
