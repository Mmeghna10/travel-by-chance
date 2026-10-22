const mongoose = require("mongoose");
const Booking = require("../models/booking.js");
const bookingService = require("../modules/bookings/service.js");
const lifecycle = require("../modules/bookings/lifecycle.js");
const ExpressError = require("../utils/ExpressError.js");
const { formatDay, todayIn } = require("../modules/bookings/dates.js");

function serialize(booking) {
  return {
    id: String(booking._id),
    listingId: String(booking.listing._id || booking.listing),
    status: booking.status,
    checkIn: formatDay(booking.checkIn),
    checkOut: formatDay(booking.checkOut),
    nights: booking.nights,
    currency: booking.currency,
    amountPaise: booking.amountPaise,
    expiresAt: booking.expiresAt,
    paidAt: booking.paidAt,
    cancelledAt: booking.cancelledAt,
  };
}

// POST /api/v1/bookings  (JSON: listingId, checkIn, checkOut; header Idempotency-Key)
module.exports.createBooking = async (req, res) => {
  const { listingId, checkIn, checkOut } = req.body || {};
  const { requirePayment, holdMinutes } = req.app.get("bookingOptions");
  const result = await bookingService.createBooking({
    userId: req.user._id,
    listingId,
    checkIn,
    checkOut,
    idempotencyKey: req.get("Idempotency-Key"),
    requirePayment,
    holdMinutes,
  });
  if (result.replayed) res.set("Idempotent-Replayed", "true");
  res.status(result.statusCode).json(result.body);
};

// GET /api/v1/listings/:id/quote?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD
module.exports.quote = async (req, res) => {
  const { checkIn, checkOut } = req.query;
  const result = await bookingService.getQuote({ listingId: req.params.id, checkIn, checkOut });
  res.json({ success: true, ...result });
};

// GET /api/v1/bookings/:id  (owner only; others get 404, same as non-existent)
module.exports.showBooking = async (req, res) => {
  const booking = mongoose.isValidObjectId(req.params.id)
    ? await Booking.findOne({ _id: req.params.id, user: req.user._id })
    : null;
  if (!booking) throw new ExpressError(404, "Booking not found.", "BOOKING_NOT_FOUND");
  res.json({ success: true, booking: serialize(booking) });
};

// POST /api/v1/bookings/:id/cancel
module.exports.cancelBookingApi = async (req, res) => {
  const { booking, changed } = await lifecycle.cancelBooking({ bookingId: req.params.id, userId: req.user._id });
  res.json({ success: true, changed, booking: serialize(booking) });
};

// POST /bookings/:id/cancel  (form on the My Bookings page)
module.exports.cancelBookingForm = async (req, res) => {
  try {
    const { booking, changed } = await lifecycle.cancelBooking({ bookingId: req.params.id, userId: req.user._id });
    const refunding = booking.status === "REFUND_PENDING";
    req.flash("success", changed ? (refunding ? "Booking cancelled. Your refund is being processed." : "Booking cancelled.") : "This booking was already cancelled.");
  } catch (err) {
    if (!(err instanceof ExpressError) || err.statusCode >= 500) throw err;
    req.flash("error", err.message);
  }
  res.redirect("/bookings");
};

// GET /bookings (page). The filter on req.user is the object-level access
// check: users only ever see their own bookings.
module.exports.indexBookings = async (req, res) => {
  const bookings = await Booking.find({ user: req.user._id })
    .populate("listing")
    .sort({ createdAt: -1 });

  // Cancellation is allowed until the check-in day (same rule as the service).
  res.render("users/bookings.ejs", { bookings, today: todayIn() });
};
