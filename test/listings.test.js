const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Listing = require("../models/listing.js");
const Review = require("../models/review.js");
const { startDb, stopDb, resetDb, buildApp, createUser, loginAgent, createListing, request, day, newKey } = require("./helpers.js");

const XSS = "</script><script>window.pwned=1</script>";

let app;
before(async () => {
  await startDb();
  app = buildApp();
});
after(stopDb);
beforeEach(resetDb);

test("a review comment cannot break out of the inline <script> on the listing page", async () => {
  const host = await createUser("host", "admin");
  const guest = await createUser("guest");
  const listing = await createListing(host, { title: `Cabin ${XSS}` });
  const review = await Review.create({ comment: XSS, rating: 5, author: guest._id });
  listing.reviews.push(review);
  await listing.save();

  const res = await request(app).get(`/listings/${listing._id}`);
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes(XSS), "raw payload must not appear anywhere in the page");
  assert.ok(res.text.includes("&lt;/script&gt;"), "comment is still shown, HTML-escaped");
});

test("the listing page does not expose host or reviewer emails", async () => {
  const host = await createUser("host", "admin");
  const guest = await createUser("guest");
  const listing = await createListing(host);
  const review = await Review.create({ comment: "Lovely", rating: 4, author: guest._id });
  listing.reviews.push(review);
  await listing.save();

  const res = await request(app).get(`/listings/${listing._id}`);
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes("host@example.com"));
  assert.ok(!res.text.includes("guest@example.com"));
  assert.ok(res.text.includes("@guest"), "usernames are still shown");
});

test("anonymous page views don't create sessions (no cookie, no session write)", async () => {
  const mongoose = require("mongoose");
  const sessions = () => mongoose.connection.db.collection("sessions").countDocuments();
  const before = await sessions();
  for (const url of ["/", "/listings", "/login", "/signup"]) {
    const res = await request(app).get(url);
    assert.equal(res.status, 200, url);
    assert.equal(res.headers["set-cookie"], undefined, `${url} must not set a session cookie`);
  }
  assert.equal(await sessions(), before);
});

test("flash messages still work: shown once, then gone", async () => {
  await createUser("flashy");
  const agent = request.agent(app);
  await agent.post("/login").type("form").send({ username: "flashy", password: "wrong-password-1" });
  const first = await agent.get("/login");
  assert.ok(first.text.includes("Password or username is incorrect"), "failure message shown");
  const second = await agent.get("/login");
  assert.ok(!second.text.includes("Password or username is incorrect"), "shown only once");
});

test("security headers are set", async () => {
  const res = await request(app).get("/listings");
  assert.match(res.headers["content-security-policy"], /object-src 'none'/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-powered-by"], undefined);
});

test("search treats regex metacharacters literally", async () => {
  const host = await createUser("host", "admin");
  await createListing(host, { title: "Plain cabin" });

  // Previously "(" was an invalid regex -> 500.
  const bad = await request(app).get("/listings").query({ q: "(" });
  assert.notEqual(bad.status, 500);

  // ".*" must not match everything.
  const dotStar = await request(app).get("/api/search-suggestions").query({ q: ".*" });
  assert.equal(dotStar.status, 200);
  assert.deepEqual(dotStar.body, []);

  const real = await request(app).get("/api/search-suggestions").query({ q: "plain" });
  assert.equal(real.body.length, 1);
});

test("query-operator injection via category is not interpreted", async () => {
  const host = await createUser("host", "admin");
  await createListing(host);
  const res = await request(app).get("/api/search-suggestions?q=te&category[$ne]=x");
  assert.equal(res.status, 200);
  const page = await request(app).get("/listings?category[$ne]=zzz");
  assert.notEqual(page.status, 500);
});

test("malformed and unknown listing ids return 404, not 500", async () => {
  const host = await createUser("host", "admin");
  const agent = await loginAgent(app, "host");
  const missing = new mongoose.Types.ObjectId();

  assert.equal((await request(app).get("/listings/not-an-id")).status, 404);
  assert.equal((await agent.get(`/listings/${missing}/edit`)).status, 404);
  assert.equal(
    (await agent.post(`/listings/${missing}/reviews`).type("form").send({ review: { rating: 5, comment: "x" } })).status,
    404,
  );
});

test("JSON clients get JSON errors", async () => {
  await createUser("guest");
  const agent = await loginAgent(app, "guest");
  const res = await agent
    .post("/api/v1/bookings")
    .set("Idempotency-Key", newKey())
    .send({ listingId: "nope", checkIn: day(1), checkOut: day(3) });
  assert.equal(res.status, 404);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, "LISTING_NOT_FOUND");
});

test("the owner can edit a listing via the multipart edit form", async () => {
  const host = await createUser("host", "admin");
  const listing = await createListing(host);
  const agent = await loginAgent(app, "host");

  const res = await agent
    .post(`/listings/${listing._id}?_method=PUT`)
    .field("listing[title]", "Renamed Cabin")
    .field("listing[description]", "Still quiet")
    .field("listing[price]", "1500")
    .field("listing[location]", listing.location)
    .field("listing[country]", listing.country)
    .field("listing[category]", "Camping");
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/listings/${listing._id}`);

  const updated = await Listing.findById(listing._id);
  assert.equal(updated.title, "Renamed Cabin");
  assert.equal(updated.price, 1500);
  assert.equal(updated.category, "Camping");
  assert.equal(updated.image.filename, "sample", "image kept when no new file is uploaded");
});

test("a different admin cannot edit someone else's listing", async () => {
  const host = await createUser("host", "admin");
  await createUser("rival", "admin");
  const listing = await createListing(host);
  const agent = await loginAgent(app, "rival");

  const res = await agent
    .post(`/listings/${listing._id}?_method=PUT`)
    .field("listing[title]", "Hijacked")
    .field("listing[description]", "x")
    .field("listing[price]", "1")
    .field("listing[location]", "x")
    .field("listing[country]", "x")
    .field("listing[category]", "Rooms");
  assert.equal(res.status, 302);
  assert.equal((await Listing.findById(listing._id)).title, "Test Cabin");
});

test("reviews get their own creation time", async () => {
  const host = await createUser("host", "admin");
  const a = await Review.create({ comment: "a", rating: 3, author: host._id });
  await new Promise((r) => setTimeout(r, 20));
  const b = await Review.create({ comment: "b", rating: 3, author: host._id });
  assert.ok(b.createdAt > a.createdAt);
});
