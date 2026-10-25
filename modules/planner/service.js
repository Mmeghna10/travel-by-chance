// Puts the planner together for one booking: places near the stay (from the
// OpenStreetMap cache), real travel times (Mapbox), each place's hours on
// the arrival date, then the scheduler. Returns a view model the page and
// the API render as-is.
const Joi = require("joi");
const { placesNear } = require("./places.js");
const { travelMatrix, MAX_POINTS } = require("./travelTimes.js");
const { openIntervals } = require("./hours.js");
const { planDay } = require("./scheduler.js");
const { MODES, TRAVEL_MODES, modeBeforeCheckIn } = require("./modes.js");
const { toMinutes, formatMinutes, HHMM } = require("./time.js");
const { haversine } = require("./geo.js");
const { SEED_PLACEHOLDER, NOT_FOUND } = require("../listings/geocode.js");
const { formatDay } = require("../bookings/dates.js");

const DEFAULT_DAY_END = "21:00";
const SEARCH_RADIUS_KM = { walking: 3, other: 12 };

const prefsSchema = Joi.object({
  arrivalTime: Joi.string().pattern(HHMM).required().messages({ "string.pattern.base": "Arrival time must look like 07:30" }),
  mode: Joi.string()
    .valid(...TRAVEL_MODES)
    .required(),
  rentalMinutes: Joi.number().integer().min(0).max(240).default(30),
  dayEndsAt: Joi.string().pattern(HHMM).default(DEFAULT_DAY_END).messages({ "string.pattern.base": "End of day must look like 21:00" }),
});

const sameCoords = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const MAPS_MODE = { walking: "walking", public_transport: "transit" };
const directions = (from, to, mode) =>
  `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&travelmode=${MAPS_MODE[mode] || "driving"}`;

/** Why the planner can't run for this stay, or null if it can. */
function unavailableReason(listing) {
  if (String(listing.country || "").trim().toLowerCase() !== "india") return "The arrival-day planner covers stays in India for now.";
  const c = listing.geometry && listing.geometry.coordinates;
  if (!c || c.length !== 2 || sameCoords(c, SEED_PLACEHOLDER) || sameCoords(c, NOT_FOUND)) {
    return "This stay doesn't have a map location yet, so nearby places can't be found.";
  }
  return null;
}

function stopView(stop, from, mode, km) {
  const p = stop.place;
  return {
    name: p.name,
    localName: p.localName,
    kind: p.kind.replace(/_/g, " "),
    travelMinutes: stop.travelMinutes,
    km,
    arriveAt: formatMinutes(stop.arrive),
    waitMinutes: stop.wait,
    startAt: formatMinutes(stop.start),
    leaveAt: formatMinutes(stop.leave),
    visitMinutes: p.visitMinutes,
    closesAt: stop.closesAt >= 1440 ? "midnight" : formatMinutes(stop.closesAt),
    hoursConfirmed: p.hoursConfirmed,
    hoursSource: p.hoursConfirmed ? p.hoursSource : "typical",
    hoursNote: p.hoursNote,
    directionsUrl: directions(from, p, mode),
  };
}

function windowView(win, hotel, kmMatrix, nodeOf) {
  if (!win) return null;
  let from = hotel;
  let fromNode = 0;
  const stops = win.stops.map((s) => {
    const node = nodeOf(s.place);
    const view = stopView(s, from, win.mode, kmMatrix[fromNode][node]);
    from = s.place;
    fromNode = node;
    return view;
  });
  return {
    mode: win.mode,
    modeLabel: MODES[win.mode].label,
    modeNote: MODES[win.mode].note,
    startAt: formatMinutes(win.start),
    // Later than startAt when the first place opens later: rest until then.
    leaveHotelAt: win.stops.length && win.leaveHotelAt > win.start ? formatMinutes(win.leaveHotelAt) : null,
    endAt: formatMinutes(win.end),
    stops,
    returnAt: formatMinutes(win.returnAt),
    returnTravelMinutes: win.returnTravelMinutes || 0,
    returnDirectionsUrl: stops.length ? directions(from, hotel, win.mode) : null,
    rentalMinutes: win.rentalMinutes || 0,
  };
}

/**
 * @returns {Promise<{status: "ready", plan} | {status: "pending"} | {status: "failed"|"unavailable", message}>}
 */
async function arrivalPlan({ booking, listing, prefs, deps = {} }) {
  const reason = unavailableReason(listing);
  if (reason) return { status: "unavailable", message: reason };

  const [lng, lat] = listing.geometry.coordinates;
  const hotel = { lat, lng };
  const isoDate = formatDay(booking.checkIn);
  const near = await placesNear(lat, lng, deps.places);
  if (near.status === "pending") return { status: "pending" };
  if (near.status === "failed") return { status: "failed", message: near.error };

  const { mode } = prefs;
  const radiusKm = mode === "walking" ? SEARCH_RADIUS_KM.walking : SEARCH_RADIUS_KM.other;
  const candidates = near.places
    .map((p) => ({ ...p, distanceKm: haversine(lat, lng, p.lat, p.lng) / 1000 }))
    .filter((p) => p.distanceKm <= radiusKm)
    .sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm)
    .slice(0, MAX_POINTS - 1)
    .map((p) => {
      const { intervals, confirmed } = openIntervals(p.openingHours, isoDate, p);
      return { ...p, intervals, hoursConfirmed: confirmed };
    });

  const points = [hotel, ...candidates];
  const profiles = [...new Set([MODES[modeBeforeCheckIn(mode)].profile, MODES[mode].profile])];
  const matrices = {};
  for (const profile of profiles) matrices[profile] = await travelMatrix(points, profile, deps.travel);

  const day = planDay({
    arrival: toMinutes(prefs.arrivalTime),
    checkIn: toMinutes(listing.checkInTime || "12:00"),
    dayEnd: toMinutes(prefs.dayEndsAt || DEFAULT_DAY_END),
    mode,
    rentalMinutes: prefs.rentalMinutes || 0,
    places: candidates,
    rawTravel: (m) => {
      const minutes = matrices[MODES[m].profile].minutes;
      return (a, b) => minutes[a][b];
    },
  });

  const nodeOf = (place) => candidates.indexOf(place) + 1;
  const kmFor = (m) => matrices[MODES[m].profile].km;
  const before = windowView(day.before, hotel, day.before ? kmFor(day.before.mode) : null, nodeOf);
  const after = windowView(day.after, hotel, day.after ? kmFor(day.after.mode) : null, nodeOf);
  const scheduled = [...(before ? before.stops : []), ...(after ? after.stops : [])];

  const notes = [];
  if (Object.values(matrices).some((m) => m.source === "estimate")) {
    notes.push("Travel times are estimates from distance (the live routing service was unavailable).");
  }
  if (mode === "public_transport" || (day.after && day.after.mode === "public_transport")) notes.push(`Public transport: ${MODES.public_transport.note}.`);
  const unconfirmed = scheduled.filter((s) => !s.hoursConfirmed).length;
  if (unconfirmed) {
    notes.push(`${unconfirmed} place(s) have no published opening hours on OpenStreetMap; they're planned within typical hours (9 am-6 pm). Check before going.`);
  }
  if (day.before) notes.push("Before check-in, we assume you leave your luggage at the hotel first (15 min); most hotels hold bags for early arrivals.");
  notes.push(
    listing.locationPrecision === "address"
      ? "Distances are measured from the stay's address. Opening hours change; check them before you go."
      : "Distances are measured from the city centre (this stay has no street address yet), so the first and last legs are approximate. Opening hours change; check them before you go.",
  );

  return {
    status: "ready",
    plan: {
      date: isoDate,
      hotel: { title: listing.title, location: `${listing.location}, ${listing.country}`, checkInTime: formatMinutes(toMinutes(listing.checkInTime || "12:00")) },
      arrivalAt: formatMinutes(toMinutes(prefs.arrivalTime)),
      checkInAt: formatMinutes(day.checkInAt),
      modeLabel: MODES[mode].label,
      before,
      after,
      placesConsidered: candidates.length,
      placesNearby: near.places.length,
      travelSource: Object.values(matrices).every((m) => m.source === "mapbox") ? "mapbox" : "estimate",
      notes,
    },
  };
}

module.exports = { arrivalPlan, prefsSchema, unavailableReason, DEFAULT_DAY_END };
