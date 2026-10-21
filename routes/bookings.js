const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync.js");
const { isLoggedIn } = require("../middleware.js");
const bookingController = require("../controllers/bookings.js");

// Creating bookings moved to POST /api/v1/bookings (routes/api.js).
router.get("/", isLoggedIn, wrapAsync(bookingController.indexBookings));

module.exports = router;
