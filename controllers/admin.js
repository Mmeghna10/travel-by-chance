const Listing = require("../models/listing.js");
const Booking = require("../models/booking.js");
const User = require("../models/user.js");

module.exports.dashboard = async (req, res) => {
  const listingsCount = await Listing.countDocuments();
  const bookingsCount = await Booking.countDocuments();
  const usersCount = await User.countDocuments();

  const listings = await Listing.find({}).populate("owner", "username");
  const bookings = await Booking.find({})
    .populate("listing")
    .populate("user", "username")
    .sort({ createdAt: -1 });

  res.render("admin/dashboard.ejs", {
    listingsCount,
    bookingsCount,
    usersCount,
    listings,
    bookings
  });
};
