// Stay dates are calendar days, not instants. A stay from 2026-08-12 to
// 2026-08-15 occupies the NIGHTS of the 12th, 13th and 14th; the check-out day
// is free for the next guest. Every day is stored as UTC midnight so the same
// string always maps to the same Date regardless of the server's time zone.
const ExpressError = require("../../utils/ExpressError.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NIGHTS = 30;
const MAX_ADVANCE_DAYS = 365;
// "Today" for deciding what is in the past. The business is in India.
const BOOKING_TIMEZONE = process.env.BOOKING_TIMEZONE || "Asia/Kolkata";

// "2026-08-12" -> Date(2026-08-12T00:00:00Z), or null if malformed/impossible.
function parseDay(str) {
  if (typeof str !== "string" || !DATE_RE.test(str)) return null;
  const d = new Date(`${str}T00:00:00Z`);
  // Rejects dates JS would silently roll over, e.g. 2026-02-30 -> March 2.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== str) return null;
  return d;
}

function formatDay(date) {
  return date.toISOString().slice(0, 10);
}

function todayIn(timeZone = BOOKING_TIMEZONE, now = new Date()) {
  // en-CA formats as YYYY-MM-DD
  return parseDay(new Intl.DateTimeFormat("en-CA", { timeZone }).format(now));
}

// Every night of the stay, ascending: [checkIn, ..., checkOut - 1 day].
function nightsBetween(checkIn, checkOut) {
  const nights = [];
  for (let t = checkIn.getTime(); t < checkOut.getTime(); t += DAY_MS) {
    nights.push(new Date(t));
  }
  return nights;
}

function validateStay(checkInStr, checkOutStr, { now = new Date() } = {}) {
  const checkIn = parseDay(checkInStr);
  const checkOut = parseDay(checkOutStr);
  if (!checkIn || !checkOut) {
    throw new ExpressError(400, "Dates must be valid and in YYYY-MM-DD format.", "INVALID_DATES");
  }
  if (checkOut <= checkIn) {
    throw new ExpressError(400, "Check-out must be after check-in.", "INVALID_DATES");
  }
  const today = todayIn(BOOKING_TIMEZONE, now);
  if (checkIn < today) {
    throw new ExpressError(400, "Check-in cannot be in the past.", "INVALID_DATES");
  }
  if (checkIn > new Date(today.getTime() + MAX_ADVANCE_DAYS * DAY_MS)) {
    throw new ExpressError(400, `Bookings open at most ${MAX_ADVANCE_DAYS} days ahead.`, "INVALID_DATES");
  }
  const nights = nightsBetween(checkIn, checkOut);
  if (nights.length > MAX_NIGHTS) {
    throw new ExpressError(400, `A stay can be at most ${MAX_NIGHTS} nights.`, "INVALID_DATES");
  }
  return { checkIn, checkOut, nights };
}

module.exports = { parseDay, formatDay, todayIn, nightsBetween, validateStay, MAX_NIGHTS, DAY_MS };
