// "Plan my arrival day": the guest says when they'll arrive and how they'll
// get around; the planner suggests what to see before and after check-in.
const mongoose = require("mongoose");
const Booking = require("../models/booking.js");
const ExpressError = require("../utils/ExpressError.js");
const { arrivalPlan, prefsSchema, unavailableReason, DEFAULT_DAY_END } = require("../modules/planner/service.js");
const { TRAVEL_MODES, MODES } = require("../modules/planner/modes.js");

// Only stays that are still going ahead get a plan.
const PLANNABLE = new Set(["PENDING_PAYMENT", "CONFIRMED"]);

// Owner-only, like every other booking endpoint: someone else's booking is a 404.
async function ownBooking(req) {
  const booking = mongoose.isValidObjectId(req.params.id)
    ? await Booking.findOne({ _id: req.params.id, user: req.user._id }).populate("listing")
    : null;
  if (!booking || !booking.listing) throw new ExpressError(404, "Booking not found.", "BOOKING_NOT_FOUND");
  return booking;
}

const savedPrefs = (booking) =>
  booking.arrival && booking.arrival.time
    ? { arrivalTime: booking.arrival.time, mode: booking.arrival.mode, rentalMinutes: booking.arrival.rentalMinutes, dayEndsAt: booking.arrival.dayEndsAt }
    : null;

// GET /bookings/:id/plan
module.exports.showPlanner = async (req, res) => {
  const booking = await ownBooking(req);
  const listing = booking.listing;
  res.render("users/plan.ejs", {
    booking,
    listing,
    plannable: PLANNABLE.has(booking.status),
    unavailable: unavailableReason(listing),
    prefs: savedPrefs(booking) || { arrivalTime: listing.checkInTime || "12:00", mode: "cab", rentalMinutes: 30, dayEndsAt: DEFAULT_DAY_END },
    modes: TRAVEL_MODES.map((key) => ({ key, label: MODES[key].label })),
  });
};

// PUT /api/v1/bookings/:id/arrival  { arrivalTime, mode, rentalMinutes?, dayEndsAt? }
module.exports.saveArrival = async (req, res) => {
  const booking = await ownBooking(req);
  if (!PLANNABLE.has(booking.status)) throw new ExpressError(409, "This booking is no longer active.", "BOOKING_NOT_ACTIVE");
  const { error, value } = prefsSchema.validate(req.body || {}, { stripUnknown: true });
  if (error) throw new ExpressError(400, error.details.map((d) => d.message).join(", "), "INVALID_ARRIVAL");
  booking.arrival = {
    time: value.arrivalTime,
    mode: value.mode,
    rentalMinutes: value.mode === "rental" ? value.rentalMinutes : undefined,
    dayEndsAt: value.dayEndsAt,
    updatedAt: new Date(),
  };
  await booking.save();
  res.json({ success: true, arrival: savedPrefs(booking) });
};

// GET /api/v1/bookings/:id/arrival-plan
// 202 while nearby places are still being fetched (first visit to an area);
// the page polls until it gets the plan.
module.exports.getPlan = async (req, res) => {
  const booking = await ownBooking(req);
  if (!PLANNABLE.has(booking.status)) throw new ExpressError(409, "This booking is no longer active.", "BOOKING_NOT_ACTIVE");
  const prefs = savedPrefs(booking);
  if (!prefs) throw new ExpressError(409, "Tell us when you'll arrive first.", "ARRIVAL_DETAILS_MISSING");

  const result = await arrivalPlan({ booking, listing: booking.listing, prefs, deps: req.app.get("plannerDeps") });
  if (result.status === "pending") {
    return res.status(202).json({ success: true, status: "pending", message: "Finding places near your stay. The first time for an area can take up to a minute." });
  }
  if (result.status === "unavailable") return res.status(422).json({ success: false, status: "unavailable", code: "PLANNER_UNAVAILABLE", message: result.message });
  if (result.status === "failed") return res.status(503).json({ success: false, status: "failed", code: "PLACES_UNAVAILABLE", message: result.message });
  res.json({ success: true, status: "ready", plan: result.plan });
};
