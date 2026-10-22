const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Remembers the outcome of a request so a retry with the same Idempotency-Key
// returns the same response instead of performing the action again.
const idempotencyRecordSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  scope: { type: String, required: true }, // e.g. "booking.create"
  key: { type: String, required: true },
  requestHash: { type: String, required: true }, // detects key reuse with a different payload
  statusCode: { type: Number, required: true },
  responseBody: { type: Schema.Types.Mixed, required: true },
  // Retries happen within seconds or minutes; MongoDB's TTL monitor deletes
  // records a day later so the collection doesn't grow forever.
  createdAt: { type: Date, default: Date.now, expires: 24 * 60 * 60 },
});

// The guarantee: only one record (and therefore one booking) per user+scope+key,
// even when duplicate requests hit different server instances at the same time.
idempotencyRecordSchema.index({ user: 1, scope: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("IdempotencyRecord", idempotencyRecordSchema);
