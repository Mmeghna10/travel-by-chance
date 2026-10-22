// Logging, request IDs, redaction, error reporting and metrics.
const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { logger, capturedLogs } = require("../modules/observability/logger.js");
const { registry } = require("../modules/observability/metrics.js");
const { addErrorReporter } = require("../modules/observability/errors.js");
const h = require("./helpers.js");

let app;
let host;
let listing;
before(async () => {
  await h.startDb();
  app = h.buildApp();
});
after(h.stopDb);
beforeEach(async () => {
  await h.resetDb();
  host = await h.createUser("host", "admin");
  listing = await h.createListing(host, { units: 1 });
  capturedLogs.length = 0;
  logger.level = "info";
});
afterEach(() => {
  logger.level = "silent";
});

// Value of a metric series, e.g. metricValue("booking_attempts_total", { outcome: "created" }).
async function metricValue(name, labels = {}) {
  const metric = await registry.getSingleMetric(name).get();
  const match = metric.values.find((v) => Object.entries(labels).every(([k, val]) => String(v.labels[k]) === String(val)));
  return match ? match.value : 0;
}

const UUID_RE = /^[0-9a-f-]{36}$/;

test("every response carries an X-Request-Id; a well-formed incoming one is kept, a bad one replaced", async () => {
  const generated = await h.request(app).get("/listings");
  assert.match(generated.headers["x-request-id"], UUID_RE);

  const kept = await h.request(app).get("/listings").set("X-Request-Id", "lb-trace-12345678");
  assert.equal(kept.headers["x-request-id"], "lb-trace-12345678");

  // Log-injection attempt (spaces/newline) and oversize ids are not trusted.
  for (const bad of ["x y\nfake log line", "a".repeat(500), "short"]) {
    const res = await h.request(app).get("/listings").set("X-Request-Id", bad.replace(/\n/g, " "));
    assert.match(res.headers["x-request-id"], UUID_RE, JSON.stringify(bad.slice(0, 20)));
  }
});

test("access log lines are structured JSON with request id, route, status and user, but no cookies", async () => {
  await h.createUser("guest");
  const agent = await h.loginAgent(app, "guest");
  capturedLogs.length = 0;

  const res = await agent.get("/bookings");
  const line = capturedLogs.find((l) => l.req && l.req.url === "/bookings");
  assert.ok(line, "access log written");
  assert.equal(line.msg, "GET /bookings 200", "message uses the full path, not the router-relative one");
  assert.equal(line.level, 30); // info
  assert.equal(line.req.id, res.headers["x-request-id"]);
  assert.equal(line.req.method, "GET");
  assert.equal(line.res.statusCode, 200);
  assert.ok(line.userId, "logged-in user id recorded");
  assert.equal(typeof line.responseTime, "number");
  assert.ok(!JSON.stringify(capturedLogs).includes("tbc.sid"), "session cookie never logged");
});

test("passwords never reach the logs (signup, login, and explicit attempts)", async () => {
  const password = "Sup3r-Secret-Pass!";
  await h.request(app).post("/signup").type("form").send({ username: "newbie", email: "n@example.com", password });
  await h.request(app).post("/login").type("form").send({ username: "newbie", password });
  // Even if a developer logs an object containing secrets, redaction catches it.
  logger.info({ password, user: { password }, razorpay_signature: "abc123sig", config: { keySecret: "k" } }, "oops");

  const all = JSON.stringify(capturedLogs);
  assert.ok(!all.includes(password));
  assert.ok(!all.includes("abc123sig"));
  const oops = capturedLogs.find((l) => l.msg === "oops");
  assert.equal(oops.password, "[REDACTED]");
  assert.equal(oops.user.password, "[REDACTED]");
  assert.equal(oops.config.keySecret, "[REDACTED]");
});

test("business log lines inside a request share that request's id (async correlation)", async () => {
  await h.createUser("guest");
  const agent = await h.loginAgent(app, "guest");
  capturedLogs.length = 0;

  const res = await agent
    .post("/api/v1/bookings")
    .set("Idempotency-Key", h.newKey())
    .send({ listingId: String(listing._id), checkIn: h.day(10), checkOut: h.day(12) });
  const reqId = res.headers["x-request-id"];
  const created = capturedLogs.find((l) => l.msg === "booking created");
  assert.ok(created, "booking log written");
  assert.equal(created.reqId, reqId, "logged deep in the service, still tagged with the request id");
  assert.equal(created.bookingId, res.body.booking.id);
  assert.equal(created.amountPaise, res.body.booking.amountPaise);
});

test("unexpected errors go to the error reporter with the request id; clients get no internals", async () => {
  const reported = [];
  addErrorReporter((err, ctx) => reported.push({ err, ctx }));
  const Listing = require("../models/listing.js");
  const realFind = Listing.find;
  Listing.find = () => {
    throw new Error("database exploded at 0xDEADBEEF");
  };
  let res;
  try {
    res = await h.request(app).get("/listings");
  } finally {
    Listing.find = realFind;
  }
  assert.equal(res.status, 500);
  assert.ok(!res.text.includes("0xDEADBEEF"), "internals not shown to the client");
  assert.equal(reported.length, 1);
  assert.match(reported[0].err.message, /exploded/);
  const errLine = capturedLogs.find((l) => l.err && /exploded/.test(l.err.message));
  assert.equal(errLine.reqId, res.headers["x-request-id"]);
  assert.ok(errLine.err.stack, "stack trace logged for debugging");
});

test("/metrics exposes Prometheus metrics with route templates, not raw ids", async () => {
  await h.request(app).get(`/listings/${listing._id}`);
  await h.request(app).get("/listings"); // router index route
  await h.request(app).get("/listings/not-an-id"); // error raised inside the router (404)
  await h.request(app).get(`/api/v1/listings/${listing._id}/quote?checkIn=${h.day(5)}&checkOut=${h.day(6)}`);
  await h.request(app).get("/wp-admin/setup-config.php"); // bot probe: matches nothing
  const res = await h.request(app).get("/metrics");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/plain/);
  const routes = new Set([...res.text.matchAll(/http_request_duration_seconds_count\{[^}]*route="([^"]+)"/g)].map((m) => m[1]));
  for (const expected of ["/listings/:id", "/listings", "/api/v1/listings/:id/quote", "unmatched"]) {
    assert.ok(routes.has(expected), `route label ${expected} in ${[...routes].join(", ")}`);
  }
  assert.match(res.text, /route="\/listings\/:id",status_code="404"/, "404 from inside the router keeps its template");
  for (const bad of ["/listings/", "/:id", "/wp-admin/setup-config.php", "not-an-id"]) {
    assert.ok(!routes.has(bad), `no label ${bad}`);
  }
  assert.ok(!res.text.includes(String(listing._id)), "no unbounded label values");
  assert.match(res.text, /process_cpu_seconds_total/); // default runtime metrics
  assert.match(res.text, /nodejs_eventloop_lag_seconds/);
});

test("/metrics can be protected with a bearer token", async () => {
  const protectedApp = h.buildApp({}, {}, { metricsToken: "scrape-token-123" });
  assert.equal((await h.request(protectedApp).get("/metrics")).status, 401);
  assert.equal((await h.request(protectedApp).get("/metrics").set("Authorization", "Bearer wrong")).status, 401);
  assert.equal((await h.request(protectedApp).get("/metrics").set("Authorization", "Bearer scrape-token-123")).status, 200);
});

test("booking metrics: attempts by outcome, inventory conflicts, transitions, DB write conflicts", async () => {
  const before = {
    created: await metricValue("booking_attempts_total", { outcome: "created" }),
    soldOut: await metricValue("booking_attempts_total", { outcome: "sold_out" }),
    invalid: await metricValue("booking_attempts_total", { outcome: "invalid" }),
    conflicts: await metricValue("booking_inventory_conflicts_total"),
    writeConflicts: await metricValue("mongodb_command_failures_total", { code_name: "WriteConflict" }),
  };

  const server = await h.listen(app);
  try {
    const names = Array.from({ length: 15 }, (_, i) => `m${i}`);
    await Promise.all(names.map((n) => h.createUser(n)));
    const agents = await Promise.all(names.map((n) => h.loginAgent(server, n)));
    const responses = await Promise.all(
      agents.map((a) =>
        a.post("/api/v1/bookings").set("Idempotency-Key", h.newKey()).send({ listingId: String(listing._id), checkIn: h.day(20), checkOut: h.day(21) }),
      ),
    );
    assert.equal(responses.filter((r) => r.status === 201).length, 1);
    await agents[0].post("/api/v1/bookings").set("Idempotency-Key", h.newKey()).send({ listingId: String(listing._id), checkIn: "bad", checkOut: h.day(2) });
  } finally {
    await new Promise((r) => server.close(r));
  }

  assert.equal((await metricValue("booking_attempts_total", { outcome: "created" })) - before.created, 1);
  assert.equal((await metricValue("booking_attempts_total", { outcome: "sold_out" })) - before.soldOut, 14);
  assert.equal((await metricValue("booking_attempts_total", { outcome: "invalid" })) - before.invalid, 1);
  assert.equal((await metricValue("booking_inventory_conflicts_total")) - before.conflicts, 14);
  // Concurrent transactions on the same night: the driver sees WriteConflict
  // errors and retries. This is the measurable cost of contention.
  const writeConflicts = (await metricValue("mongodb_command_failures_total", { code_name: "WriteConflict" })) - before.writeConflicts;
  assert.ok(writeConflicts > 0, `expected WriteConflict failures to be counted, got ${writeConflicts}`);

  const metricsText = await registry.metrics();
  assert.match(metricsText, /mongodb_command_duration_seconds_count\{command="update"\}/);
});
