const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const User = require("../models/user.js");
const { startDb, stopDb, resetDb, buildApp, createUser, loginAgent, request, PASSWORD } = require("./helpers.js");

let app;
before(async () => {
  await startDb();
  app = buildApp();
});
after(stopDb);
beforeEach(resetDb);

test("signup ignores a submitted role=admin and creates a customer", async () => {
  const res = await request(app)
    .post("/signup")
    .type("form")
    .send({ username: "mallory", email: "mallory@example.com", password: PASSWORD, role: "admin" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/listings");

  const user = await User.findOne({ username: "mallory" });
  assert.equal(user.role, "customer");
});

test("signup rejects a short password without creating a user", async () => {
  const res = await request(app)
    .post("/signup")
    .type("form")
    .send({ username: "shorty", email: "shorty@example.com", password: "123" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/signup");
  assert.equal(await User.countDocuments({ username: "shorty" }), 0);
});

test("a customer cannot open the admin dashboard", async () => {
  await createUser("alice");
  const agent = await loginAgent(app, "alice");
  const res = await agent.get("/admin");
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/listings");
});

test("an admin created out-of-band can open the dashboard", async () => {
  await createUser("host", "admin");
  const agent = await loginAgent(app, "host");
  const res = await agent.get("/admin");
  assert.equal(res.status, 200);
});

test("session cookie is HttpOnly and SameSite=Lax", async () => {
  await createUser("bob");
  const res = await request(app).post("/login").type("form").send({ username: "bob", password: PASSWORD });
  const cookie = res.headers["set-cookie"].find((c) => c.startsWith("tbc.sid="));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
});

test("login is rate limited per IP", async () => {
  const limitedApp = buildApp({ authMax: 3 });
  const attempt = () => request(limitedApp).post("/login").type("form").send({ username: "x", password: "wrong-password" });
  for (let i = 0; i < 3; i++) {
    assert.equal((await attempt()).status, 302);
  }
  assert.equal((await attempt()).status, 429);
  // GET of the login page is not counted.
  assert.equal((await request(limitedApp).get("/login")).status, 200);
});

test("logout redirects and ends the session", async () => {
  await createUser("carol");
  const agent = await loginAgent(app, "carol");
  assert.equal((await agent.get("/logout")).status, 302);
  const res = await agent.get("/bookings");
  assert.equal(res.status, 401);
});
