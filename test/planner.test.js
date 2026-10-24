// Arrival-day planner through the real API and a real database, with
// OpenStreetMap and Mapbox replaced by stand-ins (no network in tests).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("../models/booking.js");
const PlaceCache = require("../models/placeCache.js");
const { settle, toPlaces, resetPlacesState } = require("../modules/planner/places.js");
const { haversine } = require("../modules/planner/geo.js");
const h = require("./helpers.js");

const AGRA = { lat: 27.1749, lng: 78.0088 };
const THURSDAY = "2026-11-05";
const FRIDAY = "2026-11-06";

// What Overpass returns for Agra (shapes as in a real response).
const OSM_AGRA = [
  { type: "way", id: 1, center: { lat: 27.1751, lon: 78.0421 }, tags: { tourism: "attraction", name: "ताज महल", "name:en": "Taj Mahal", wikidata: "Q9141" } },
  // Same monument again, 50 m away (a node inside the outline): dropped.
  { type: "node", id: 2, lat: 27.1754, lon: 78.0423, tags: { historic: "tomb", name: "Taj Mahal" } },
  { type: "way", id: 3, center: { lat: 27.1795, lon: 78.0211 }, tags: { historic: "fort", name: "Agra Fort", wikidata: "Q188664" } },
  { type: "node", id: 4, lat: 27.1925, lon: 78.0307, tags: { historic: "tomb", name: "Itimad-ud-Daulah", wikipedia: "en:Tomb of I'timād-ud-Daulah" } },
  { type: "node", id: 5, lat: 27.18, lon: 78.012, tags: { tourism: "museum", name: "Small Museum", opening_hours: "Mo-Sa 10:00-17:00" } },
  { type: "node", id: 6, lat: 27.17, lon: 78.0, tags: { tourism: "viewpoint" } }, // no name: ignored
];

let overpassCalls = 0;
let mapboxCalls = 0;
let overpassMode = "ok";
let mapboxMode = "ok";

const deps = {
  places: {
    fetchElements: async () => {
      overpassCalls++;
      if (overpassMode === "fail") throw new Error("Overpass 504");
      return OSM_AGRA;
    },
  },
  travel: {
    token: "test-token",
    fetchImpl: async (url) => {
      mapboxCalls++;
      if (mapboxMode === "fail") return { ok: false, status: 500, json: async () => ({ code: "ServerError" }) };
      const coords = url.split("/mapbox/")[1].split("/")[1].split("?")[0].split(";").map((c) => c.split(",").map(Number));
      const profile = url.split("/mapbox/")[1].split("/")[0];
      const speed = profile === "walking" ? 1.2 : 7; // m/s
      const d = coords.map(([lngA, latA]) => coords.map(([lngB, latB]) => haversine(latA, lngA, latB, lngB) * 1.3));
      return { ok: true, status: 200, json: async () => ({ code: "Ok", durations: d.map((r) => r.map((m) => m / speed)), distances: d }) };
    },
  },
};

let app;
let host;
let guest;
before(async () => {
  await h.startDb();
  app = h.buildApp();
  app.set("plannerDeps", deps);
});
after(h.stopDb);
beforeEach(async () => {
  await h.resetDb();
  resetPlacesState();
  overpassCalls = 0;
  mapboxCalls = 0;
  overpassMode = "ok";
  mapboxMode = "ok";
  host = await h.createUser("host", "admin");
  await h.createUser("guest");
  guest = await h.loginAgent(app, "guest");
});

async function agraBooking({ date = THURSDAY, status = "CONFIRMED", country = "India", user } = {}) {
  const listing = await h.createListing(host, {
    title: "Taj View Room",
    location: "Agra",
    country,
    checkInTime: "12:00",
    geometry: { type: "Point", coordinates: [AGRA.lng, AGRA.lat] },
  });
  const owner = user || (await require("../models/user.js").findOne({ username: "guest" }));
  const checkIn = new Date(`${date}T00:00:00Z`);
  return Booking.create({ listing: listing._id, user: owner._id, checkIn, checkOut: new Date(checkIn.getTime() + 86400000), status, totalPrice: 1000, nights: 1 });
}

const saveArrival = (agent, id, body) => agent.put(`/api/v1/bookings/${id}/arrival`).send(body);
async function planFor(agent, id) {
  let res = await agent.get(`/api/v1/bookings/${id}/arrival-plan`);
  if (res.status === 202) {
    await settle(AGRA.lat, AGRA.lng);
    res = await agent.get(`/api/v1/bookings/${id}/arrival-plan`);
  }
  return res;
}
const allStops = (plan) => [...(plan.before ? plan.before.stops : []), ...(plan.after ? plan.after.stops : [])];

test("OpenStreetMap results: English names, duplicates dropped, curated hours applied", () => {
  const places = toPlaces(OSM_AGRA);
  const names = places.map((p) => p.name);
  assert.deepEqual(names.filter((n) => n === "Taj Mahal").length, 1, "duplicate within 150 m dropped");
  assert.ok(!names.includes(undefined));
  const taj = places.find((p) => p.name === "Taj Mahal");
  assert.equal(taj.localName, "ताज महल");
  assert.equal(taj.hoursSource, "curated");
  assert.match(taj.openingHours, /Fr off/);
  assert.match(taj.hoursNote, /tajmahal\.gov\.in/);
  assert.equal(places.find((p) => p.name === "Small Museum").hoursSource, "openstreetmap");
  assert.equal(places.find((p) => p.name === "Itimad-ud-Daulah").hoursSource, "typical");
});

test("early arrival by cab: a plan before and after check-in, all within opening hours", async () => {
  const booking = await agraBooking();
  assert.equal((await saveArrival(guest, booking._id, { arrivalTime: "07:00", mode: "cab", dayEndsAt: "20:00" })).status, 200);

  const first = await guest.get(`/api/v1/bookings/${booking._id}/arrival-plan`);
  assert.equal(first.status, 202, "first request for an area: places are fetched in the background");
  const res = await planFor(guest, booking._id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { plan } = res.body;
  assert.equal(plan.checkInAt, "12:00 pm");
  assert.equal(plan.travelSource, "mapbox");
  assert.ok(plan.before.stops.length >= 1, "something to see before check-in");
  assert.equal(plan.before.mode, "cab");
  const names = allStops(plan).map((s) => s.name);
  assert.equal(new Set(names).size, names.length, "no place twice");
  assert.ok(names.includes("Taj Mahal"), "open on Thursday");
  for (const s of allStops(plan)) assert.match(s.directionsUrl, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&/);
  assert.ok(plan.notes.some((n) => /luggage/.test(n)));
});

test("Friday: the Taj Mahal is never suggested", async () => {
  const booking = await agraBooking({ date: FRIDAY });
  await saveArrival(guest, booking._id, { arrivalTime: "07:00", mode: "cab" });
  const { plan } = (await planFor(guest, booking._id)).body;
  assert.ok(allStops(plan).length > 0);
  assert.ok(!allStops(plan).some((s) => s.name === "Taj Mahal"));
});

test("rental: rental time is used after check-in; walking keeps to nearby places", async () => {
  const booking = await agraBooking();
  await saveArrival(guest, booking._id, { arrivalTime: "13:00", mode: "rental", rentalMinutes: 60, dayEndsAt: "21:00" });
  const { plan } = (await planFor(guest, booking._id)).body;
  assert.equal(plan.before, null, "arrived after check-in time");
  assert.equal(plan.checkInAt, "1:00 pm");
  assert.equal(plan.after.startAt, "2:30 pm", "1 pm + 30 min check-in + 60 min rental");
  assert.equal(plan.after.rentalMinutes, 60);

  await saveArrival(guest, booking._id, { arrivalTime: "13:00", mode: "walking" });
  const walk = (await planFor(guest, booking._id)).body.plan;
  for (const s of allStops(walk)) assert.ok(s.km <= 4.5, `${s.name} is walkable`);
});

test("places are fetched from OpenStreetMap once, then served from the cache", async () => {
  const booking = await agraBooking();
  await saveArrival(guest, booking._id, { arrivalTime: "09:00", mode: "cab" });
  await planFor(guest, booking._id);
  await planFor(guest, booking._id);
  assert.equal(overpassCalls, 1);
  assert.equal(await PlaceCache.countDocuments(), 1);
  assert.equal(mapboxCalls, 1, "travel times cached too");
});

test("Mapbox down: still a plan, with estimated travel times and a note", async () => {
  mapboxMode = "fail";
  const booking = await agraBooking();
  await saveArrival(guest, booking._id, { arrivalTime: "09:00", mode: "cab" });
  const { plan } = (await planFor(guest, booking._id)).body;
  assert.equal(plan.travelSource, "estimate");
  assert.ok(plan.notes.some((n) => /estimates from distance/.test(n)));
  assert.ok(allStops(plan).length > 0);
});

test("OpenStreetMap down: a clear 503, not a crash", async () => {
  overpassMode = "fail";
  const booking = await agraBooking();
  await saveArrival(guest, booking._id, { arrivalTime: "09:00", mode: "cab" });
  const res = await planFor(guest, booking._id);
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "PLACES_UNAVAILABLE");
});

test("only the booking's owner can plan; validation; inactive and non-India bookings", async () => {
  const booking = await agraBooking();
  await h.createUser("mallory");
  const mallory = await h.loginAgent(app, "mallory");
  assert.equal((await saveArrival(mallory, booking._id, { arrivalTime: "07:00", mode: "cab" })).status, 404);
  assert.equal((await mallory.get(`/api/v1/bookings/${booking._id}/arrival-plan`)).status, 404);
  assert.equal((await mallory.get(`/bookings/${booking._id}/plan`)).status, 404);

  assert.equal((await guest.get(`/api/v1/bookings/${booking._id}/arrival-plan`)).body.code, "ARRIVAL_DETAILS_MISSING");
  const bad = await saveArrival(guest, booking._id, { arrivalTime: "7am", mode: "teleport" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "INVALID_ARRIVAL");

  const cancelled = await agraBooking({ status: "CANCELLED" });
  assert.equal((await saveArrival(guest, cancelled._id, { arrivalTime: "07:00", mode: "cab" })).body.code, "BOOKING_NOT_ACTIVE");

  const abroad = await agraBooking({ country: "Japan" });
  await saveArrival(guest, abroad._id, { arrivalTime: "07:00", mode: "cab" });
  const res = await guest.get(`/api/v1/bookings/${abroad._id}/arrival-plan`);
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "PLANNER_UNAVAILABLE");
});

test("the planner page and the My Bookings button", async () => {
  const booking = await agraBooking();
  const page = await guest.get(`/bookings/${booking._id}/plan`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("Plan my arrival day"));
  assert.ok(page.text.includes('value="12:00"'), "defaults the arrival time to the check-in time");
  assert.ok(page.text.includes("/js/planner.js"));
  const list = await guest.get("/bookings");
  assert.ok(list.text.includes(`/bookings/${booking._id}/plan`));
});

test("hosts set a check-in time; invalid times are rejected", async () => {
  const hostAgent = await h.loginAgent(app, "host");
  const listing = await h.createListing(host);
  const edit = (checkInTime) =>
    hostAgent
      .post(`/listings/${listing._id}?_method=PUT`)
      .field("listing[title]", "Cabin")
      .field("listing[description]", "Quiet")
      .field("listing[price]", "1500")
      .field("listing[location]", listing.location)
      .field("listing[country]", listing.country)
      .field("listing[category]", "Camping")
      .field("listing[checkInTime]", checkInTime);
  assert.equal((await edit("14:00")).status, 302);
  assert.equal((await require("../models/listing.js").findById(listing._id)).checkInTime, "14:00");
  const bad = await edit("2pm");
  assert.equal(bad.status, 400);
});
