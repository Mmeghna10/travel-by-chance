// Street addresses: an exact map pin when the address is found, the city
// otherwise. The Mapbox lookup is replaced by a stand-in.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Listing = require("../models/listing.js");
const listingController = require("../controllers/listings.js");
const h = require("./helpers.js");

const BUILDING = [78.0402, 27.1645];
const CITY = [78.0088, 27.1749];
const lookups = [];
before(async () => {
  await h.startDb();
  listingController.setPlaceLookup(async (query) => {
    lookups.push(query);
    if (query.startsWith("12 Fatehabad Road")) return { type: "Point", coordinates: BUILDING };
    if (query.startsWith("Nowhere Lane")) return null;
    return { type: "Point", coordinates: CITY };
  });
});
after(async () => {
  listingController.setPlaceLookup(null);
  await h.stopDb();
});

let app;
let host;
let agent;
beforeEach(async () => {
  await h.resetDb();
  lookups.length = 0;
  app = h.buildApp();
  host = await h.createUser("host", "admin");
  agent = await h.loginAgent(app, "host");
});

const edit = (listing, address) =>
  agent
    .post(`/listings/${listing._id}?_method=PUT`)
    .field("listing[title]", "Taj View Room")
    .field("listing[description]", "Near the Taj")
    .field("listing[price]", "4000")
    .field("listing[location]", "Agra")
    .field("listing[country]", "India")
    .field("listing[category]", "Rooms")
    .field("listing[address]", address);

test("a found address gives an exact pin, shown on the page", async () => {
  const listing = await h.createListing(host, { location: "Agra" });
  assert.equal((await edit(listing, "12 Fatehabad Road, Tajganj")).status, 302);
  const saved = await Listing.findById(listing._id);
  assert.deepEqual([...saved.geometry.coordinates], BUILDING);
  assert.equal(saved.locationPrecision, "address");
  assert.equal(lookups[0], "12 Fatehabad Road, Tajganj, Agra", "address + city sent to the geocoder");
  const page = await h.request(app).get(`/listings/${listing._id}`);
  assert.ok(page.text.includes("12 Fatehabad Road, Tajganj"));
  assert.ok(!page.text.includes("Map shows the area"));
});

test("an address that can't be found falls back to the city, and says so", async () => {
  const listing = await h.createListing(host, { location: "Agra" });
  await edit(listing, "Nowhere Lane 99");
  const saved = await Listing.findById(listing._id);
  assert.deepEqual([...saved.geometry.coordinates], CITY);
  assert.equal(saved.locationPrecision, "city");
  const page = await agent.get(`/listings/${listing._id}`);
  assert.ok(page.text.includes("couldn&#39;t find that street address") || page.text.includes("couldn't find that street address"));
  assert.ok(page.text.includes("Map shows the area"));
});

test("removing the address goes back to the city pin; no change = no lookup", async () => {
  const listing = await h.createListing(host, { location: "Agra" });
  await edit(listing, "12 Fatehabad Road, Tajganj");
  lookups.length = 0;
  await edit(listing, "12 Fatehabad Road, Tajganj");
  assert.equal(lookups.length, 0, "unchanged address isn't looked up again");
  await edit(listing, "");
  const saved = await Listing.findById(listing._id);
  assert.equal(saved.locationPrecision, "city");
  assert.deepEqual([...saved.geometry.coordinates], CITY);
});
