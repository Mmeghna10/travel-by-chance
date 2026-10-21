const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// One document per (listing, night). `reserved` counts units taken by active
// bookings that night. The invariant `reserved <= listing.units` is enforced by
// the conditional update in modules/bookings/inventory.js, not by this schema.
const inventoryNightSchema = new Schema({
  listing: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
  date: { type: Date, required: true }, // UTC midnight of the night
  reserved: { type: Number, required: true, default: 0, min: 0 },
});

// Exactly one counter per listing-night, so concurrent requests contend on the
// same document instead of each creating their own.
inventoryNightSchema.index({ listing: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("InventoryNight", inventoryNightSchema);
