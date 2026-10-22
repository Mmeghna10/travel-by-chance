const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// A refund request is created in the SAME transaction that moves a booking to
// REFUND_PENDING (transactional outbox). The refund worker then calls
// Razorpay. So "booking needs a refund" can never be committed without the
// refund being queued, and a crash between the two can't lose it.
//
//   REQUESTED  - queued, not yet sent (or waiting for a retry after an error)
//   SUBMITTING - a worker holds a short lease and is calling Razorpay
//   PENDING    - Razorpay accepted it, outcome not final yet
//   PROCESSED  - Razorpay confirmed the money went back (final)
//   FAILED     - Razorpay reported failure, or we gave up after retries (final; needs a human)
const REFUND_STATUSES = ["REQUESTED", "SUBMITTING", "PENDING", "PROCESSED", "FAILED"];

const refundSchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    amountPaise: { type: Number, required: true },
    status: { type: String, enum: REFUND_STATUSES, required: true, default: "REQUESTED" },
    // Our own reference, sent to Razorpay as `receipt`. After a crash we look
    // for an existing refund with this receipt before creating another.
    receipt: { type: String, required: true },
    paymentId: String, // pay_xxx being refunded
    razorpayRefundId: String, // rfnd_xxx
    attempts: { type: Number, default: 0 },
    lockedUntil: Date, // lease for SUBMITTING
    nextAttemptAt: Date, // backoff after an error
    lastError: String,
    processedAt: Date,
  },
  { timestamps: true },
);

// One full refund per booking: re-entering REFUND_PENDING can't queue a second one.
refundSchema.index({ booking: 1 }, { unique: true });
refundSchema.index({ razorpayRefundId: 1 }, { unique: true, sparse: true });
refundSchema.index({ status: 1, nextAttemptAt: 1 });

module.exports = mongoose.model("Refund", refundSchema);
module.exports.REFUND_STATUSES = REFUND_STATUSES;
