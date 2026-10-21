// Versioned JSON API. Breaking changes go to /api/v2 so existing clients keep working.
const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync.js");
const { isLoggedIn } = require("../middleware.js");
const bookingController = require("../controllers/bookings.js");

router.get("/listings/:id/quote", wrapAsync(bookingController.quote));
router.post("/bookings", isLoggedIn, wrapAsync(bookingController.createBooking));

module.exports = router;
