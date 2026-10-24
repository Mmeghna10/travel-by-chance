// India-only listings, real amenities, and pages that don't claim things
// that aren't true.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Listing = require("../models/listing.js");
const Review = require("../models/review.js");
const Booking = require("../models/booking.js");
const InventoryNight = require("../models/inventoryNight.js");
const { removeListingsOutsideIndia } = require("../modules/listings/removeOutsideIndia.js");
const h = require("./helpers.js");

let app;
let host;
before(async () => {
  await h.startDb();
  app = h.buildApp();
});
after(h.stopDb);
beforeEach(async () => {
  await h.resetDb();
  host = await h.createUser("host", "admin");
});

const editForm = (agent, listing, fields = {}) => {
  const req = agent
    .post(`/listings/${listing._id}?_method=PUT`)
    .field("listing[title]", "Cabin")
    .field("listing[description]", "Quiet")
    .field("listing[price]", "1500")
    .field("listing[location]", listing.location)
    .field("listing[country]", fields.country || "India")
    .field("listing[category]", "Camping");
  for (const a of fields.amenities || []) req.field("listing[amenities]", a);
  return req;
};

test("listings must be in India", async () => {
  const listing = await h.createListing(host);
  const agent = await h.loginAgent(app, "host");
  const res = await editForm(agent, listing, { country: "Japan" });
  assert.equal(res.status, 400);
  assert.match(res.text, /India only/);
  assert.equal((await Listing.findById(listing._id)).country, "India", "unchanged");
  const form = await agent.get("/listings/new");
  assert.match(form.text, /name="listing\[country\]" id="country" value="India"[^>]*readonly/);
});

test("amenities: the page shows only what the host ticked; unticking all removes them", async () => {
  const listing = await h.createListing(host);
  const agent = await h.loginAgent(app, "host");

  let page = await h.request(app).get(`/listings/${listing._id}`);
  assert.ok(!page.text.includes("What's included"), "no amenities, no section (it used to list 8 for every stay)");
  assert.ok(!page.text.includes("Gym"));

  assert.equal((await editForm(agent, listing, { amenities: ["wifi", "pool"] })).status, 302);
  assert.deepEqual([...(await Listing.findById(listing._id)).amenities], ["wifi", "pool"]);
  page = await h.request(app).get(`/listings/${listing._id}`);
  assert.ok(page.text.includes("What&#39;s included") || page.text.includes("What's included"));
  assert.ok(page.text.includes("Free WiFi") && page.text.includes("Pool"));
  assert.ok(!page.text.includes("Gym"));

  assert.equal((await editForm(agent, listing, { amenities: ["breakfast"] })).status, 302, "a single ticked box arrives as a string");
  assert.deepEqual([...(await Listing.findById(listing._id)).amenities], ["breakfast"]);

  assert.equal((await editForm(agent, listing, {})).status, 302);
  assert.deepEqual([...(await Listing.findById(listing._id)).amenities], [], "nothing ticked = nothing");

  assert.equal((await editForm(agent, listing, { amenities: ["helipad"] })).status, 400, "unknown amenity rejected");
});

test("pages no longer make claims that aren't true", async () => {
  const listing = await h.createListing(host);
  const show = (await h.request(app).get(`/listings/${listing._id}`)).text;
  for (const claim of ["Superhost", "Member since 2024", "Exact address shared after booking", "Total before taxes"]) {
    assert.ok(!show.includes(claim), `listing page: "${claim}"`);
  }
  assert.ok(show.includes('href="/refund-policy"'));
  const home = (await h.request(app).get("/")).text;
  for (const claim of ["200+", "Active Hosts", "50K+", "Verified Properties", "24/7 Guest Care", "Start Hosting Today", "Across the World"]) {
    assert.ok(!home.includes(claim), `home page: "${claim}"`);
  }
  assert.ok(home.includes("Across India"));
  assert.ok(!home.includes('href="#" aria-label="Instagram"'), "no dead social links");
});

test("home page numbers are counted from the database, not made up", async () => {
  await h.createListing(host, { location: "Goa" });
  await h.createListing(host, { location: "Goa" });
  const third = await h.createListing(host, { location: "Jaipur" });
  let home = (await h.request(app).get("/")).text;
  for (const fake of ["500+", "50+", "4.8 ★"]) assert.ok(!home.includes(fake), `no "${fake}"`);
  assert.match(home, />3<\/div>\s*<div[^>]*>Stays<\/div>/);
  assert.match(home, />2<\/div>\s*<div[^>]*>Cities in India<\/div>/);
  assert.ok(!home.includes("Avg rating"), "no rating shown without reviews");

  const guest = await h.createUser("guest");
  for (const rating of [4, 5]) {
    const review = await Review.create({ comment: "Good", rating, author: guest._id });
    third.reviews.push(review._id);
  }
  await third.save();
  home = (await h.request(app).get("/")).text;
  assert.ok(home.includes("4.5 ★"), "real average");
  assert.match(home, /Avg rating · 2 reviews/);
});

test("removing listings outside India: dry run, guests protected, backup, clean removal", async () => {
  const guest = await h.createUser("guest");
  const india = await h.createListing(host, { title: "Goa Villa", location: "Goa" });
  const free = await h.createListing(host, { title: "Tokyo Flat", location: "Tokyo", country: "Japan" });
  const review = await Review.create({ comment: "Nice", rating: 5, author: guest._id });
  free.reviews.push(review._id);
  await free.save();
  await InventoryNight.create({ listing: free._id, date: new Date("2026-01-10T00:00:00Z"), reserved: 0 });
  const pastStay = await h.createListing(host, { title: "Malibu Cottage", location: "Malibu", country: "United States" });
  const upcoming = await h.createListing(host, { title: "NYC Loft", location: "New York City", country: "United States" });

  const now = new Date("2026-10-24T12:00:00Z");
  const stay = (listing, checkIn, status) =>
    Booking.create({ listing: listing._id, user: guest._id, checkIn: new Date(checkIn), checkOut: new Date(new Date(checkIn).getTime() + 86400000), status, totalPrice: 100 });
  await stay(pastStay, "2026-07-17T00:00:00Z", "CONFIRMED"); // already over: doesn't block
  await stay(upcoming, "2026-12-05T00:00:00Z", "CONFIRMED"); // a guest is coming: blocks

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbc-backup-"));
  const dry = await removeListingsOutsideIndia({ backupDir: dir, now });
  assert.equal(dry.found.length, 3);
  assert.deepEqual(dry.blocked.map((b) => b.listing.title), ["NYC Loft"]);
  assert.equal(await Listing.countDocuments(), 4, "dry run removes nothing");
  assert.equal(fs.readdirSync(dir).length, 0);

  const run = await removeListingsOutsideIndia({ apply: true, backupDir: dir, label: "test", now });
  assert.equal(run.removed, 2);
  assert.deepEqual((await Listing.find().sort({ title: 1 })).map((l) => l.title), ["Goa Villa", "NYC Loft"]);
  assert.equal(await Review.countDocuments(), 0, "reviews removed with the listing");
  assert.equal(await InventoryNight.countDocuments({ listing: free._id }), 0);
  assert.equal(await Booking.countDocuments(), 2, "booking history is kept");

  const backup = JSON.parse(fs.readFileSync(run.backupFile, "utf8"));
  assert.deepEqual(backup.map((b) => b.listing.title).sort(), ["Malibu Cottage", "Tokyo Flat"]);
  assert.equal(backup.find((b) => b.listing.title === "Tokyo Flat").reviews[0].comment, "Nice");

  const again = await removeListingsOutsideIndia({ apply: true, backupDir: dir, now });
  assert.equal(again.removed, 0, "safe to re-run");
  assert.ok(india);
});

test("My Bookings still works for a booking whose stay was removed", async () => {
  const guest = await h.createUser("guest");
  const gone = await h.createListing(host, { country: "Japan" });
  await Booking.create({ listing: gone._id, user: guest._id, checkIn: new Date("2026-07-01"), checkOut: new Date("2026-07-02"), status: "CONFIRMED", totalPrice: 100 });
  await Listing.deleteOne({ _id: gone._id });
  const agent = await h.loginAgent(app, "guest");
  assert.equal((await agent.get("/bookings")).status, 200);
});
