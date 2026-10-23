// Session storage after turning off connect-mongo's encryption (which cost a
// synchronous PBKDF2 per session read and write; see docs/07).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const signature = require("cookie-signature");
const h = require("./helpers.js");

let app;
before(async () => {
  await h.startDb();
  app = h.buildApp();
});
after(h.stopDb);
beforeEach(h.resetDb);

const sessions = () => mongoose.connection.db.collection("sessions");

test("a logged-in session is stored as plain JSON and keeps working", async () => {
  await h.createUser("guest");
  const agent = await h.loginAgent(app, "guest");
  const [doc] = await sessions().find().toArray();
  const stored = JSON.parse(doc.session);
  assert.equal(stored.passport.user, "guest");
  assert.ok(stored.cookie, "readable without a key");
  assert.equal((await agent.get("/bookings")).status, 200, "still logged in on the next request");
});

test("a session saved while encryption was on logs the user out instead of crashing", async () => {
  // What connect-mongo stored with crypto on: the session is ciphertext.
  const sid = "legacy-encrypted-session";
  await sessions().insertOne({
    _id: sid,
    session: JSON.stringify({ hmac: "a1b2", ct: "c3d4", iv: "e5f6", at: "g7h8" }),
    expires: new Date(Date.now() + 86400000),
  });
  const cookie = `tbc.sid=${encodeURIComponent("s:" + signature.sign(sid, "test-secret"))}`;

  const res = await h.request(app).get("/bookings").set("Cookie", cookie).set("Accept", "text/html");
  assert.equal(res.status, 302, "treated as logged out");
  assert.equal(res.headers.location, "/login");
  assert.equal(await sessions().countDocuments({ _id: sid }), 0, "the unreadable session is deleted");

  const page = await h.request(app).get("/listings").set("Cookie", cookie);
  assert.equal(page.status, 200, "public pages work with the stale cookie too");
});
