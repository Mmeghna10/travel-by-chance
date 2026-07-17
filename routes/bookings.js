const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync.js");
const { isLoggedIn } = require("../middleware.js");
const bookingController = require("../controllers/bookings.js");

router.route("/")
  .post(isLoggedIn, wrapAsync(bookingController.createBooking))
  .get(isLoggedIn, wrapAsync(bookingController.indexBookings));

module.exports = router;
