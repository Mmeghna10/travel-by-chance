const Booking = require("../models/booking.js");
const bookingService = require("../modules/bookings/service.js");

// POST /api/v1/bookings  (JSON: listingId, checkIn, checkOut; header Idempotency-Key)
module.exports.createBooking = async (req, res) => {
  const { listingId, checkIn, checkOut } = req.body || {};
  const result = await bookingService.createBooking({
    userId: req.user._id,
    listingId,
    checkIn,
    checkOut,
    idempotencyKey: req.get("Idempotency-Key"),
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

// GET /bookings (page). The filter on req.user is the object-level access
// check: users only ever see their own bookings.
module.exports.indexBookings = async (req, res) => {
  const bookings = await Booking.find({ user: req.user._id })
    .populate("listing")
    .sort({ createdAt: -1 });

  res.render("users/bookings.ejs", { bookings });
};
