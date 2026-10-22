// Brings bookings created before Milestone 2 (no `status`, no inventory) into
// the new model: each gets status CONFIRMED and, if its stay hasn't ended,
// its nights are reserved in InventoryNight so new bookings can't overlap it.
//
// The old code never checked overlaps, so the database may already contain
// double bookings. Bookings are processed oldest first; a later booking whose
// nights are already full is reported as a conflict and left untouched for an
// admin to resolve (contact the guest, cancel, relocate).
//
// Everything runs in ONE transaction. In dry-run mode it is aborted at the end,
// so you see exactly what would happen without changing anything (apart from
// creating empty night counters, which is harmless).
const mongoose = require("mongoose");
const Booking = require("../../models/booking.js");
const Listing = require("../../models/listing.js");
const { nightsBetween, formatDay } = require("./dates.js");
const { ensureNights, reserveNights, releaseNights } = require("./inventory.js");

class DryRunAbort extends Error {}

function utcMidnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function migrateLegacyBookings({ apply = false, now = new Date() } = {}) {
  const legacy = await Booking.find({ status: { $exists: false } }).sort({ createdAt: 1, _id: 1 });
  const report = { scanned: legacy.length, migrated: 0, pastStays: 0, conflicts: [] };

  // Create counters up front (outside the transaction, see inventory.js).
  const plans = [];
  for (const booking of legacy) {
    const checkIn = utcMidnight(booking.checkIn);
    const checkOut = utcMidnight(booking.checkOut);
    const nights = nightsBetween(checkIn, checkOut).filter((d) => d >= utcMidnight(now));
    const listing = await Listing.findById(booking.listing).select("units");
    plans.push({ booking, checkIn, checkOut, nights, listing });
    if (listing && nights.length) await ensureNights(listing._id, nights);
  }

  try {
    await mongoose.connection.transaction(async (session) => {
      // The callback can be retried on transient errors; start from scratch each time.
      Object.assign(report, { migrated: 0, pastStays: 0, conflicts: [] });

      for (const { booking, checkIn, checkOut, nights, listing } of plans) {
        const describe = () => ({
          bookingId: String(booking._id),
          listingId: String(booking.listing),
          checkIn: formatDay(checkIn),
          checkOut: formatDay(checkOut),
        });

        if (nights.length > 0) {
          if (!listing) {
            report.conflicts.push({ ...describe(), reason: "listing deleted" });
            continue;
          }
          // A savepoint per booking: try its nights; on SOLD_OUT undo just this
          // booking's increments so the transaction can continue.
          const reserved = [];
          try {
            for (const night of nights) {
              await reserveNights(listing._id, [night], listing.units, session);
              reserved.push(night);
            }
          } catch (err) {
            if (err.code !== "SOLD_OUT") throw err;
            await releaseNights(listing._id, reserved, session);
            report.conflicts.push({ ...describe(), reason: "overlaps an earlier booking" });
            continue;
          }
        } else {
          report.pastStays++;
        }

        const nightsCount = nightsBetween(checkIn, checkOut).length;
        await Booking.updateOne(
          { _id: booking._id, status: { $exists: false } },
          {
            $set: {
              status: "CONFIRMED",
              checkIn,
              checkOut,
              nights: nightsCount,
              currency: "INR",
              amountPaise: Math.round(booking.totalPrice * 100),
            },
          },
          { session },
        );
        report.migrated++;
      }

      if (!apply) throw new DryRunAbort();
    });
  } catch (err) {
    if (!(err instanceof DryRunAbort)) throw err;
  }

  report.applied = apply;
  return report;
}

module.exports = { migrateLegacyBookings };
