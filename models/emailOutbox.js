// Emails waiting to be sent: a transactional outbox. A row is written in the
// SAME transaction as the booking change it announces, so there's never an
// email for a change that rolled back, nor a change whose email is lost. The
// background worker sends them (modules/notifications/outbox.js).
const mongoose = require("mongoose");

const EMAIL_EVENTS = ["booking_confirmed", "booking_cancelled", "refund_started", "refund_completed", "refund_delayed", "hold_expired"];

const emailOutboxSchema = new mongoose.Schema({
  // "<bookingId>:<event>": each event is emailed at most once per booking,
  // even if the transition is retried or two workers race.
  _id: String,
  booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true },
  event: { type: String, enum: EMAIL_EVENTS, required: true },
  status: { type: String, enum: ["PENDING", "SENDING", "SENT", "SKIPPED", "GAVE_UP"], default: "PENDING" },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: Date,
  lockedUntil: Date, // lease while a worker is sending
  lastError: String,
  sentAt: Date,
  createdAt: { type: Date, default: Date.now },
});
emailOutboxSchema.index({ status: 1, nextAttemptAt: 1 });

module.exports = mongoose.models.EmailOutbox || mongoose.model("EmailOutbox", emailOutboxSchema);
module.exports.EMAIL_EVENTS = EMAIL_EVENTS;
