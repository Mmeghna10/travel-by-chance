// Repairing listings whose map location is unknown (old seed put all of them
// in Delhi). The geocoder is a stand-in; the database is real.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Listing = require("../models/listing.js");
const { repairListingLocations, placeQuery, countryOf, SEED_PLACEHOLDER, NOT_FOUND } = require("../modules/listings/geocode.js");
const h = require("./helpers.js");

const PLACES = {
  "Malibu, United States": [-118.7798, 34.0259],
  "Agra, India": [78.0081, 27.1767],
};
const fakeGeocoder = () => {
  const calls = [];
  const geocode = async (query) => {
    calls.push(query);
    if (query.startsWith("Broken")) throw new Error("Mapbox 503");
    return PLACES[query] ? { type: "Point", coordinates: PLACES[query] } : null;
  };
  return { geocode, calls };
};
const at = (coordinates) => ({ geometry: { type: "Point", coordinates } });
const coordsOf = async (doc) => (await Listing.findById(doc._id).lean()).geometry.coordinates;

let host;
before(h.startDb);
after(h.stopDb);
beforeEach(async () => {
  await h.resetDb();
  host = await h.createUser("host", "admin");
});

test("dry run reports the fixes and writes nothing", async () => {
  const malibu = await h.createListing(host, { location: "Malibu", country: "United States", ...at(SEED_PLACEHOLDER) });
  const { geocode } = fakeGeocoder();
  const report = await repairListingLocations({ geocode });
  assert.equal(report.scanned, 1);
  assert.equal(report.changes[0].query, "Malibu, United States");
  assert.deepEqual(await coordsOf(malibu), SEED_PLACEHOLDER);
});

test("apply fixes placeholder and [0,0] listings, leaves real locations alone", async () => {
  const malibu = await h.createListing(host, { location: "Malibu", country: "United States", ...at(SEED_PLACEHOLDER) });
  const agra = await h.createListing(host, { location: "Agra", country: "India", ...at(NOT_FOUND) });
  const manali = await h.createListing(host, { location: "Manali", country: "India", ...at([77.19, 32.24]) });
  const { geocode, calls } = fakeGeocoder();

  const report = await repairListingLocations({ geocode, apply: true });

  assert.equal(report.fixed, 2);
  assert.deepEqual(await coordsOf(malibu), PLACES["Malibu, United States"]);
  assert.deepEqual(await coordsOf(agra), PLACES["Agra, India"]);
  assert.deepEqual(await coordsOf(manali), [77.19, 32.24]);
  assert.ok(!calls.includes("Manali, India"), "listings with a real location aren't even looked up");
});

test("no match and lookup errors are reported and left unchanged; others still fixed", async () => {
  const nowhere = await h.createListing(host, { location: "Atlantis", country: "Ocean", ...at(SEED_PLACEHOLDER) });
  await h.createListing(host, { location: "Broken", country: "Place", ...at(SEED_PLACEHOLDER) });
  const malibu = await h.createListing(host, { location: "Malibu", country: "United States", ...at(SEED_PLACEHOLDER) });

  const report = await repairListingLocations({ geocode: fakeGeocoder().geocode, apply: true });

  assert.deepEqual(report.notFound.map((r) => r.query), ["Atlantis, Ocean"]);
  assert.equal(report.failed[0].error, "Mapbox 503");
  assert.equal(report.fixed, 1);
  assert.deepEqual(await coordsOf(nowhere), SEED_PLACEHOLDER);
  assert.deepEqual(await coordsOf(malibu), PLACES["Malibu, United States"]);
});

test("re-running is a no-op", async () => {
  await h.createListing(host, { location: "Malibu", country: "United States", ...at(SEED_PLACEHOLDER) });
  await repairListingLocations({ geocode: fakeGeocoder().geocode, apply: true });
  const second = fakeGeocoder();
  const report = await repairListingLocations({ geocode: second.geocode, apply: true });
  assert.equal(report.scanned, 0);
  assert.equal(second.calls.length, 0);
});

test("never overwrites a location an admin set while the lookup was running", async () => {
  const listing = await h.createListing(host, { location: "Malibu", country: "United States", ...at(SEED_PLACEHOLDER) });
  const geocode = async (query) => {
    // The admin saves a hand-picked location mid-run.
    await Listing.updateOne({ _id: listing._id }, { $set: { "geometry.coordinates": [-118.8, 34.03] } });
    return { type: "Point", coordinates: PLACES[query] };
  };
  const report = await repairListingLocations({ geocode, apply: true });
  assert.equal(report.fixed, 0);
  assert.deepEqual(await coordsOf(listing), [-118.8, 34.03]);
});

// Both bugs below were caught in a dry run against real Mapbox before anything was written.
test("place query: no repeated name when the place is the country", () => {
  assert.equal(placeQuery({ location: "Malibu", country: "United States" }), "Malibu, United States");
  assert.equal(placeQuery({ location: "Maldives", country: "Maldives" }), "Maldives");
  assert.equal(placeQuery({ location: "fiji ", country: "Fiji" }), "Fiji");
});

test("countryOf reads Mapbox results, so matches in another country can be rejected", () => {
  // Shapes as returned by Mapbox for "Fiji, Fiji" (wrong) and "Fiji" (right).
  const taiwanTown = { place_type: ["place"], text: "集集", context: [{ id: "region.1", text: "Nantou County" }, { id: "country.2", text: "Taiwan" }] };
  const fiji = { place_type: ["country"], text: "Fiji", context: [] };
  assert.equal(countryOf(taiwanTown), "Taiwan");
  assert.equal(countryOf(fiji), "Fiji");
});
