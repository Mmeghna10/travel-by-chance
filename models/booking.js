const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// The full lifecycle is designed in docs/01-audit-and-architecture.md §7.
// Milestone 2 creates CONFIRMED bookings directly (no payment yet);
// PENDING_PAYMENT, EXPIRED and the refund states are used from Milestones 3–4.
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

const Booking = mongoose.model("Booking", bookingSchema);
module.exports = Booking;
module.exports.BOOKING_STATUSES = BOOKING_STATUSES;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
