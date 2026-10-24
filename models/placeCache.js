// Places near a point, as fetched from OpenStreetMap, kept for a while.
// The public Overpass servers took 40-70 s per query (and sometimes failed)
// when checked, so a lookup must never sit on a guest's request path twice.
// Stored in MongoDB rather than memory so every web instance shares it and
// it survives restarts and the free tier's sleep.
const mongoose = require("mongoose");

const placeCacheSchema = new mongoose.Schema({
  _id: String, // "lat,lng,radius,v<version>", coordinates rounded to ~100 m
  places: { type: mongoose.Schema.Types.Mixed, required: true },
  fetchedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});
// MongoDB deletes expired entries itself.
placeCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.PlaceCache || mongoose.model("PlaceCache", placeCacheSchema);
