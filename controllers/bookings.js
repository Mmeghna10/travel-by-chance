const Booking = require("../models/booking.js");
const Listing = require("../models/listing.js");

module.exports.createBooking = async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ success: false, message: "You must be logged in to reserve stays!" });
  }

  const { listingId, checkIn, checkOut } = req.body;
  if (!listingId || !checkIn || !checkOut) {
    return res.status(400).json({ success: false, message: "Missing required booking details." });
  }

  const listing = await Listing.findById(listingId);
  if (!listing) {
    return res.status(404).json({ success: false, message: "Listing not found." });
  }

  const d1 = new Date(checkIn);
  const d2 = new Date(checkOut);
  if (isNaN(d1.getTime()) || isNaN(d2.getTime()) || d2 <= d1) {
    return res.status(400).json({ success: false, message: "Invalid check-in or check-out date." });
  }

  const nights = Math.max(1, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));
  const subtotal = listing.price * nights;
  const clean = Math.round(listing.price * 0.05);
  const service = Math.round(listing.price * 0.12);
  const totalPrice = subtotal + clean + service;

  const newBooking = new Booking({
    listing: listingId,
    user: req.user._id,
    checkIn: d1,
    checkOut: d2,
    totalPrice: totalPrice,
  });

  await newBooking.save();

  return res.json({ success: true, message: "Booking confirmed successfully!" });
};

module.exports.indexBookings = async (req, res) => {
  if (!req.isAuthenticated()) {
    req.flash("error", "You must be logged in to view your bookings!");
    return res.redirect("/login");
  }

  const bookings = await Booking.find({ user: req.user._id })
    .populate("listing")
    .sort({ createdAt: -1 });

  res.render("users/bookings.ejs", { bookings });
};
