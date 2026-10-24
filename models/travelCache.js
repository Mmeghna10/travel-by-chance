// Travel-time matrices from Mapbox, kept for a day. Mapbox bills the Matrix
// API per element (origins x destinations), so the same hotel and places
// shouldn't be asked for again on every page view.
const mongoose = require("mongoose");

const travelCacheSchema = new mongoose.Schema({
  _id: String, // profile + rounded coordinates
  minutes: { type: [[Number]], required: true },
  km: { type: [[Number]], required: true },
  source: { type: String, enum: ["mapbox", "estimate"], required: true },
  expiresAt: { type: Date, required: true },
});
travelCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.TravelCache || mongoose.model("TravelCache", travelCacheSchema);
