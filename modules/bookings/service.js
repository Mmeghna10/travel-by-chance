// Booking use-cases. Controllers deal with HTTP; this file holds the rules.
const crypto = require("crypto");
const mongoose = require("mongoose");
const Listing = require("../../models/listing.js");
const Booking = require("../../models/booking.js");
const InventoryNight = require("../../models/inventoryNight.js");
const IdempotencyRecord = require("../../models/idempotencyRecord.js");
const ExpressError = require("../../utils/ExpressError.js");
const { validateStay, formatDay } = require("./dates.js");
const { quote } = require("./pricing.js");
const { ensureNights, reserveNights, unitsLeft } = require("./inventory.js");

const SCOPE = "booking.create";
const DEFAULT_HOLD_MINUTES = 15;
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

// Unique indexes are what make inventory and idempotency safe, so they must
// exist before the first request, not "eventually" via mongoose's background
// autoIndex. Called at startup (server.js) and in tests.
async function ensureIndexes() {
  await Promise.all([InventoryNight.createIndexes(), IdempotencyRecord.createIndexes(), Booking.createIndexes()]);
}

function hashRequest({ listingId, checkIn, checkOut }) {
  return crypto.createHash("sha256").update(JSON.stringify([String(listingId), checkIn, checkOut])).digest("hex");
}

function replay(record, requestHash) {
  // Same key + different payload is a client bug; silently returning the old
  // booking for different dates would be worse than an error.
  if (record.requestHash !== requestHash) {
    throw new ExpressError(422, "This Idempotency-Key was already used for a different request.", "IDEMPOTENCY_KEY_REUSED");
  }
  return { statusCode: record.statusCode, body: record.responseBody, replayed: true };
}

async function loadListing(listingId) {
  const listing = mongoose.isValidObjectId(listingId) ? await Listing.findById(listingId).select("price units") : null;
  if (!listing) throw new ExpressError(404, "Listing not found.", "LISTING_NOT_FOUND");
  return listing;
}

async function getQuote({ listingId, checkIn, checkOut, now }) {
  const stay = validateStay(checkIn, checkOut, { now });
  const listing = await loadListing(listingId);
  const left = await unitsLeft(listing._id, stay.nights, listing.units);
  return {
    listingId: String(listing._id),
    checkIn,
    checkOut,
    available: left > 0,
    unitsLeft: left,
    quote: quote(listing.price, stay.nights.length),
  };
}

/**
 * Creates a booking exactly once per (user, idempotencyKey).
 * With requirePayment the booking starts as PENDING_PAYMENT and holds its
 * nights for holdMinutes; otherwise it is CONFIRMED immediately.
 * Returns { statusCode, body, replayed }.
 */
async function createBooking({
  userId,
  listingId,
  checkIn,
  checkOut,
  idempotencyKey,
  now = new Date(),
  requirePayment = false,
  holdMinutes = DEFAULT_HOLD_MINUTES,
}) {
  if (typeof idempotencyKey !== "string" || !KEY_RE.test(idempotencyKey)) {
    throw new ExpressError(
      400,
      "An Idempotency-Key header (8-128 letters, digits, '-' or '_') is required.",
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  const stay = validateStay(checkIn, checkOut, { now });
  const requestHash = hashRequest({ listingId, checkIn, checkOut });
  const recordFilter = { user: userId, scope: SCOPE, key: idempotencyKey };

  // Fast path for ordinary retries. Not the guarantee (two duplicates can both
  // miss here); the unique index inside the transaction is.
  const existing = await IdempotencyRecord.findOne(recordFilter);
  if (existing) return replay(existing, requestHash);

  const listing = await loadListing(listingId);
  const price = quote(listing.price, stay.nights.length);
  await ensureNights(listing._id, stay.nights);

  // Generated up front so the stored response can contain the id, and so a
  // retried transaction attempt reuses the same id.
  const bookingId = new mongoose.Types.ObjectId();
  const status = requirePayment ? "PENDING_PAYMENT" : "CONFIRMED";
  const expiresAt = requirePayment ? new Date(now.getTime() + holdMinutes * 60 * 1000) : undefined;
  const body = {
    success: true,
    message: requirePayment ? "Dates held. Complete payment to confirm." : "Booking confirmed!",
    booking: {
      id: String(bookingId),
      listingId: String(listing._id),
      status,
      expiresAt: expiresAt ? expiresAt.toISOString() : undefined,
      checkIn: formatDay(stay.checkIn),
      checkOut: formatDay(stay.checkOut),
      nights: price.nights,
      currency: price.currency,
      amountPaise: price.totalPaise,
      priceBreakdown: {
        nightlyPaise: price.nightlyPaise,
        subtotalPaise: price.subtotalPaise,
        cleaningFeePaise: price.cleaningFeePaise,
        serviceFeePaise: price.serviceFeePaise,
      },
    },
  };

  try {
    // One transaction = one all-or-nothing unit:
    //   1. claim the idempotency key   (unique index: one winner per key)
    //   2. take a unit for every night (conditional $inc: never above units)
    //   3. insert the booking
    // If anything throws, MongoDB rolls back all three. The driver re-runs the
    // callback automatically on transient errors such as WriteConflict, which
    // is what concurrent transactions touching the same night produce.
    await mongoose.connection.transaction(async (session) => {
      await IdempotencyRecord.create([{ ...recordFilter, requestHash, statusCode: 201, responseBody: body }], {
        session,
      });
      await reserveNights(listing._id, stay.nights, listing.units, session);
      await Booking.create(
        [
          {
            _id: bookingId,
            listing: listing._id,
            user: userId,
            checkIn: stay.checkIn,
            checkOut: stay.checkOut,
            status,
            expiresAt,
            statusHistory: [{ to: status, actor: "guest", at: now, reason: "created" }],
            nights: price.nights,
            currency: price.currency,
            amountPaise: price.totalPaise,
            priceBreakdown: body.booking.priceBreakdown,
            totalPrice: price.totalPaise / 100,
          },
        ],
        { session },
      );
    });
  } catch (err) {
    // A duplicate request with the same key committed first: return its result.
    if (err.code === 11000 && err.keyPattern && err.keyPattern.key) {
      const winner = await IdempotencyRecord.findOne(recordFilter);
      if (winner) return replay(winner, requestHash);
    }
    throw err;
  }

  return { statusCode: 201, body, replayed: false };
}

module.exports = { createBooking, getQuote, ensureIndexes, SCOPE };
