const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { startDb, stopDb, buildApp, request } = require("./helpers.js");

let app;
before(async () => {
  await startDb();
  app = buildApp();
});
after(stopDb);

test("GET /healthz is 200 and creates no session cookie", async () => {
  const res = await request(app).get("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "ok" });
  assert.equal(res.headers["set-cookie"], undefined);
});

test("GET /readyz is 200 when the database is reachable", async () => {
  const res = await request(app).get("/readyz");
  assert.equal(res.status, 200);
  assert.equal(res.body.db, "ok");
});

test("GET /readyz is 503 when the database is disconnected", async (t) => {
  // Simulate the outage instead of really disconnecting: a real disconnect can
  // interrupt the session store's background index creation and surface as an
  // unhandled rejection (that made this test flaky).
  Object.defineProperty(mongoose.connection, "readyState", { get: () => 0, configurable: true });
  t.after(() => delete mongoose.connection.readyState);

  const res = await request(app).get("/readyz");
  assert.equal(res.status, 503);
});

test("GET /readyz is 503 when the database stops answering pings", async (t) => {
  t.mock.method(mongoose.connection.db, "admin", () => ({ ping: async () => { throw new Error("timeout"); } }));
  const res = await request(app).get("/readyz");
  assert.equal(res.status, 503);
});
