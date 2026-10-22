// Versioned JSON API. Breaking changes go to /api/v2 so existing clients keep working.
const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync.js");
const { isLoggedIn } = require("../middleware.js");
const bookingController = require("../controllers/bookings.js");
const paymentController = require("../controllers/payments.js");

router.get("/listings/:id/quote", wrapAsync(bookingController.quote));
router.post("/bookings", isLoggedIn, wrapAsync(bookingController.createBooking));
router.get("/bookings/:id", isLoggedIn, wrapAsync(bookingController.showBooking));
router.post("/bookings/:id/cancel", isLoggedIn, wrapAsync(bookingController.cancelBookingApi));
router.post("/bookings/:id/payment-order", isLoggedIn, wrapAsync(paymentController.createOrder));
router.post("/payments/verify", isLoggedIn, wrapAsync(paymentController.verify));
router.post("/demo-payments/:orderId/pay", isLoggedIn, wrapAsync(paymentController.demoPay));

module.exports = router;
