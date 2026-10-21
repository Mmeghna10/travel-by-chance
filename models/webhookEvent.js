const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Log of received webhook deliveries, keyed by Razorpay's x-razorpay-event-id.
// Razorpay delivers at-least-once, so the same event can arrive several times.
// A PROCESSED event is acknowledged without re-processing. Correctness does
// NOT depend on this log, though: every handler is idempotent on its own, so
// even two concurrent deliveries of one event can't confirm or refund twice.
const webhookEventSchema = new Schema({
  eventId: { type: String, required: true },
  event: String, // e.g. "payment.captured"
  status: { type: String, enum: ["RECEIVED", "PROCESSED", "FAILED"], default: "RECEIVED" },
  deliveries: { type: Number, default: 1 },
  lastError: String,
  receivedAt: { type: Date, default: Date.now },
  processedAt: Date,
});

webhookEventSchema.index({ eventId: 1 }, { unique: true });

module.exports = mongoose.model("WebhookEvent", webhookEventSchema);
