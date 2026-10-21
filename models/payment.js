const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// One Razorpay order per booking. The customer may make several payment
// attempts against that order (e.g. a declined card, then UPI); the order is
// what ties money to our booking, so it's the unit we track.
//
// Status ranks (never move to a lower rank; webhooks can arrive out of order):
//   CREATING (0) - claimed by a request that is calling Razorpay
//   CREATED  (1) - order exists, nothing paid yet
//   FAILED   (1) - last attempt failed; the customer can retry the same order
//   AUTHORIZED (2) - bank approved; not money yet (auto-capture follows)
//   CAPTURED (3) - money captured: the only state that confirms a booking
const PAYMENT_STATUSES = ["CREATING", "CREATED", "FAILED", "AUTHORIZED", "CAPTURED"];

const paymentSchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    provider: { type: String, default: "razorpay" },
    orderId: String, // order_xxx
    amountPaise: { type: Number, required: true },
    currency: { type: String, required: true },
    status: { type: String, enum: PAYMENT_STATUSES, required: true },
    creatingSince: Date,
    capturedPaymentId: String, // pay_xxx of the captured attempt
    lastPaymentId: String,
    lastFailureReason: String,
    // Webhook/API data that didn't match what we expected (wrong amount,
    // currency or order). Never acted on; kept for investigation.
    anomalies: [{ _id: false, at: Date, paymentId: String, reason: String }],
    lastReconciledAt: Date,
  },
  { timestamps: true },
);

// At most one payment record (and so one Razorpay order) per booking, even if
// the customer double-clicks "Pay" or two tabs race.
paymentSchema.index({ booking: 1 }, { unique: true });
paymentSchema.index({ orderId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ status: 1, updatedAt: 1 }); // reconciliation

module.exports = mongoose.model("Payment", paymentSchema);
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;
