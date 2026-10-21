// Per-night inventory. The core idea, in one line:
//
//   updateOne({ listing, date, reserved: { $lt: units } }, { $inc: { reserved: 1 } })
//
// MongoDB applies the filter check and the increment to a single document
// atomically. If 100 requests race for the last unit, exactly one update
// matches; the other 99 see `reserved == units`, match nothing, and get
// modifiedCount 0. There is no "read, check in JS, then write" gap to race in.
const InventoryNight = require("../../models/inventoryNight.js");
const ExpressError = require("../../utils/ExpressError.js");

function isDuplicateKeyOnly(err) {
  if (err.code === 11000) return true;
  return Array.isArray(err.writeErrors) && err.writeErrors.length > 0 && err.writeErrors.every((e) => e.code === 11000);
}

// Makes sure a counter document exists for every night, OUTSIDE the booking
// transaction. Two requests creating the same night at once is harmless: the
// unique index lets one insert win and the other gets a duplicate-key error,
// which we ignore. Doing this inside the transaction instead would turn
// "night doesn't exist yet" and "night is full" into the same failure.
async function ensureNights(listingId, nights) {
  try {
    await InventoryNight.bulkWrite(
      nights.map((date) => ({
        updateOne: {
          filter: { listing: listingId, date },
          update: { $setOnInsert: { reserved: 0 } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  } catch (err) {
    if (!isDuplicateKeyOnly(err)) throw err;
  }
}

// Takes one unit for every night, inside the caller's transaction. Nights are
// processed in date order so concurrent multi-night requests touch documents
// in the same order. If any night is full we throw, and the transaction rolls
// back the nights already incremented, so a stay is all-or-nothing.
async function reserveNights(listingId, nights, units, session) {
  for (const date of nights) {
    const res = await InventoryNight.updateOne(
      { listing: listingId, date, reserved: { $lt: units } },
      { $inc: { reserved: 1 } },
      { session },
    );
    if (res.modifiedCount !== 1) {
      throw new ExpressError(409, "Sorry, those dates are no longer available.", "SOLD_OUT");
    }
  }
}

// Gives units back (cancellation/expiry, Milestone 3). The `$gt: 0` guard
// means a bug elsewhere can never push the counter negative.
async function releaseNights(listingId, nights, session) {
  for (const date of nights) {
    await InventoryNight.updateOne(
      { listing: listingId, date, reserved: { $gt: 0 } },
      { $inc: { reserved: -1 } },
      { session },
    );
  }
}

// Read-only availability for the quote endpoint. This is ADVISORY: it can be
// stale a millisecond later. Only reserveNights() decides who gets a unit.
async function unitsLeft(listingId, nights, units) {
  const docs = await InventoryNight.find({ listing: listingId, date: { $in: nights } }).select("reserved").lean();
  const maxReserved = docs.reduce((m, d) => Math.max(m, d.reserved), 0);
  return Math.max(0, units - maxReserved);
}

module.exports = { ensureNights, reserveNights, releaseNights, unitsLeft };
