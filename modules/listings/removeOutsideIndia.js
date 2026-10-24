// TravelByChance lists stays in India only. Finds listings in other
// countries and (with apply) removes them, with their reviews and inventory
// counters, after writing a JSON backup.
//
// A listing with an active or upcoming booking (a payment hold, a pending
// refund, or a confirmed/legacy booking whose stay hasn't ended) is kept and
// reported: those guests have to be dealt with first.
const fs = require("fs");
const path = require("path");
const Listing = require("../../models/listing.js");
const Review = require("../../models/review.js");
const Booking = require("../../models/booking.js");
const InventoryNight = require("../../models/inventoryNight.js");

const NOT_INDIA = { country: { $not: /^\s*india\s*$/i } };

function blockingBookingsFilter(listingId, now) {
  return {
    listing: listingId,
    $or: [
      { status: { $in: ["PENDING_PAYMENT", "REFUND_PENDING"] } },
      // Past stays are history, not obligations.
      { status: { $in: ["CONFIRMED", null] }, checkOut: { $gt: now } },
    ],
  };
}

/**
 * @returns {Promise<{ found, removable, blocked, removed, backupFile }>}
 */
async function removeListingsOutsideIndia({ apply = false, backupDir, label = "db", now = new Date() } = {}) {
  const outside = await Listing.find(NOT_INDIA).lean();
  const removable = [];
  const blocked = [];
  for (const listing of outside) {
    const active = await Booking.countDocuments(blockingBookingsFilter(listing._id, now));
    (active ? blocked : removable).push({ listing, activeBookings: active });
  }
  const report = { found: outside, removable, blocked, removed: 0, backupFile: null };
  if (!apply || removable.length === 0) return report;

  // Back up first: everything needed to restore what's about to go.
  const backup = [];
  for (const { listing } of removable) {
    backup.push({
      listing,
      reviews: await Review.find({ _id: { $in: listing.reviews || [] } }).lean(),
      pastBookingIds: (await Booking.find({ listing: listing._id }).select("_id").lean()).map((b) => b._id),
    });
  }
  fs.mkdirSync(backupDir, { recursive: true });
  report.backupFile = path.join(backupDir, `removed-listings-${label}-${now.toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(report.backupFile, JSON.stringify(backup, null, 2));

  for (const { listing } of removable) {
    // findOneAndDelete also deletes the listing's reviews (model hook).
    const gone = await Listing.findOneAndDelete({ _id: listing._id });
    await InventoryNight.deleteMany({ listing: listing._id });
    if (gone) report.removed++;
  }
  return report;
}

module.exports = { removeListingsOutsideIndia };
