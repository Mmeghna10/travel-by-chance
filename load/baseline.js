// Local load-test baseline (no k6 needed): `npm run load:baseline`
//
// Starts the real server (`node server.js`, NODE_ENV=production, JSON logs at
// info) against a throwaway MongoDB replica set, seeds data, runs four
// scenarios with concurrent virtual users, then reports throughput, latency
// percentiles, error rate and, for the booking scenarios, checks inventory
// correctness directly in the database.
//
// Load generator, server and database share one machine, so absolute numbers
// are a LOCAL BASELINE for comparing before/after changes, not production
// capacity.
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.LOAD_PORT) || 8097;
const BASE = `http://127.0.0.1:${PORT}`;
const DURATION_MS = Number(process.env.LOAD_SECONDS || 15) * 1000;
const BROWSE_VUS = Number(process.env.LOAD_BROWSE_VUS) || 20;
const BOOKING_VUS = Number(process.env.LOAD_BOOKING_VUS) || 20;
const BURST = Number(process.env.LOAD_BURST) || 200;

const day = (n) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10);
};

// ---------------------------------------------------------------- stats
function summarize(name, samples, wallMs) {
  const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
  const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.ceil((p / 100) * lat.length) - 1)] : NaN);
  const byStatus = samples.reduce((m, s) => ((m[s.status] = (m[s.status] || 0) + 1), m), {});
  const errors = samples.filter((s) => s.status === 0 || s.status >= 500).length;
  return {
    scenario: name,
    requests: samples.length,
    "req/s": +(samples.length / (wallMs / 1000)).toFixed(1),
    "p50 ms": +pct(50).toFixed(1),
    "p95 ms": +pct(95).toFixed(1),
    "p99 ms": +pct(99).toFixed(1),
    "max ms": +lat[lat.length - 1].toFixed(1),
    "error %": +((100 * errors) / samples.length).toFixed(2),
    statuses: JSON.stringify(byStatus),
  };
}

async function timed(url, init) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { redirect: "manual", ...init });
    await res.arrayBuffer();
    return { status: res.status, ms: performance.now() - t0 };
  } catch {
    return { status: 0, ms: performance.now() - t0 };
  }
}

// Runs `vus` loops of `iteration()` for `durationMs`.
async function runFor(vus, durationMs, iteration) {
  const samples = [];
  const end = Date.now() + durationMs;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: vus }, async (_, vu) => {
      let i = 0;
      while (Date.now() < end) samples.push(await iteration(vu, i++));
    }),
  );
  return { samples, wallMs: performance.now() - t0 };
}

async function signup(username) {
  const res = await fetch(`${BASE}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, email: `${username}@example.com`, password: "load-test-password" }),
    redirect: "manual",
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  // A redirect back to /signup means validation failed; only /listings is success.
  if (res.status !== 302 || res.headers.get("location") !== "/listings" || !cookie.startsWith("tbc.sid=")) {
    throw new Error(`signup failed for ${username}: ${res.status} -> ${res.headers.get("location")}`);
  }
  return cookie;
}

const book = (cookie, listingId, checkIn, checkOut) =>
  timed(`${BASE}/api/v1/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ listingId, checkIn, checkOut }),
  });

// ---------------------------------------------------------------- main
(async () => {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const dbUrl = rs.getUri("travelbychance");

  // Seed listings (with some reviews, like real pages) straight into the DB.
  await mongoose.connect(dbUrl);
  const User = require(path.join(ROOT, "models/user.js"));
  const Listing = require(path.join(ROOT, "models/listing.js"));
  const Review = require(path.join(ROOT, "models/review.js"));
  const host = await User.register(new User({ username: "loadhost", email: "loadhost@example.com", role: "admin" }), "load-test-password");
  const categories = ["Trending", "Rooms", "Mountains", "Castles", "Camping"];
  const listings = [];
  // 0-29: 3 units (spread bookings), 30-39: 1 unit, 40+: one per burst user
  // for the no-contention control burst.
  for (let i = 0; i < 40 + BURST; i++) {
    const reviews = await Review.insertMany(
      Array.from({ length: 5 }, (_, r) => ({ comment: `Review ${r}`, rating: 1 + ((i + r) % 5), author: host._id })),
    );
    listings.push(
      await Listing.create({
        title: `Load Test Stay ${i}`,
        description: "Seeded for load testing",
        image: { url: "https://res.cloudinary.com/demo/image/upload/sample.jpg", filename: "sample" },
        price: 1000 + i * 50,
        units: i < 30 ? 3 : 1,
        location: "Manali",
        country: "India",
        category: categories[i % categories.length],
        owner: host._id,
        reviews: reviews.map((r) => r._id),
        geometry: { type: "Point", coordinates: [77.19, 32.24] },
      }),
    );
  }
  await mongoose.disconnect();

  const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      ATLASDB_URL: dbUrl,
      SECRET: "load-test-secret",
      MAP_TOKEN: process.env.MAP_TOKEN || "pk.eyJ1IjoidGVzdCJ9.test",
      DNS_SERVERS: "",
      HTTPS_ONLY: "false",
      LOG_LEVEL: "info", // realistic: production logs every request
      RAZORPAY_KEY_ID: "",
      RAZORPAY_KEY_SECRET: "",
      REQUIRE_PAYMENT: "false",
      // Every virtual user comes from 127.0.0.1, so per-IP limits would only
      // measure the rate limiter. They're raised here on purpose.
      RATE_LIMIT_AUTH_MAX: "100000",
      RATE_LIMIT_BOOKING_MAX: "100000",
    },
  });
  let started = false;
  let logLines = 0;
  server.stdout.on("data", (d) => {
    logLines += String(d).split("\n").length - 1;
    if (String(d).includes("Server running")) started = true;
  });
  server.stderr.on("data", (d) => process.stderr.write(d));
  for (let i = 0; i < 120 && !started; i++) await new Promise((r) => setTimeout(r, 250));
  if (!started) throw new Error("server did not start");

  const results = [];
  const checks = [];
  const ids = listings.map((l) => String(l._id));

  // Warm-up (JIT, connection pools), not measured.
  await runFor(10, 3000, (vu, i) => timed(`${BASE}/listings/${ids[(vu + i) % ids.length]}`));

  // 1. Browsing: list pages, detail pages, price quotes.
  {
    const tag = (kind) => (s) => ({ ...s, kind });
    const { samples, wallMs } = await runFor(BROWSE_VUS, DURATION_MS, (vu, i) => {
      const r = (vu * 7 + i) % 10;
      if (r < 5) return timed(`${BASE}/listings?category=${categories[i % categories.length]}`).then(tag("GET /listings?category"));
      if (r < 8) return timed(`${BASE}/listings/${ids[(vu + i) % ids.length]}`).then(tag("GET /listings/:id"));
      return timed(`${BASE}/api/v1/listings/${ids[(vu + i) % ids.length]}/quote?checkIn=${day(30)}&checkOut=${day(33)}`).then(
        tag("GET quote"),
      );
    });
    results.push(summarize(`browse mix (${BROWSE_VUS} VUs)`, samples, wallMs));
    // Per endpoint, so a slow endpoint can't hide inside the average.
    for (const kind of ["GET /listings?category", "GET /listings/:id", "GET quote"]) {
      results.push(summarize(`  ${kind}`, samples.filter((s) => s.kind === kind), wallMs));
    }
  }

  // 2. Bookings spread over 30 listings x many dates (little contention).
  const bookers = [];
  for (let i = 0; i < BOOKING_VUS; i++) bookers.push(await signup(`booker${i}`));
  {
    const { samples, wallMs } = await runFor(BOOKING_VUS, DURATION_MS, (vu, i) => {
      const listing = ids[(vu * 13 + i * 7) % 30];
      const start = 2 + ((vu * 31 + i * 17) % 300);
      return book(bookers[vu], listing, day(start), day(start + 2));
    });
    results.push(summarize(`bookings, spread (${BOOKING_VUS} VUs)`, samples, wallMs));
  }

  // 3 & 4. Bursts: BURST users hit the same night at the same moment.
  const racers = [];
  for (let i = 0; i < BURST; i++) racers.push(await signup(`racer${i}`));
  // Control: the same burst, but every user books a DIFFERENT listing, so no
  // night is shared. If this is as slow as the contended bursts, contention
  // isn't what makes them slow.
  {
    const t0 = performance.now();
    const samples = await Promise.all(racers.map((c, i) => book(c, ids[40 + i], day(350), day(351))));
    results.push(summarize(`burst ${BURST} users, no contention`, samples, performance.now() - t0));
  }
  for (const [label, listing, units] of [
    ["last unit", listings[35], 1],
    ["3 units", listings[0], 3],
  ]) {
    const t0 = performance.now();
    const samples = await Promise.all(racers.map((c) => book(c, String(listing._id), day(400 - 40), day(400 - 39))));
    results.push(summarize(`burst ${BURST} users, ${label}`, samples, performance.now() - t0));
    checks.push({ listing, units, created: samples.filter((s) => s.status === 201).length, label });
  }

  // ---------------------------------------------------------------- correctness
  await mongoose.connect(dbUrl);
  const Booking = require(path.join(ROOT, "models/booking.js"));
  const InventoryNight = require(path.join(ROOT, "models/inventoryNight.js"));
  const correctness = [];
  const nights = await InventoryNight.find().lean();
  const oversold = nights.filter((n) => {
    const l = listings.find((x) => String(x._id) === String(n.listing));
    return n.reserved < 0 || n.reserved > l.units;
  });
  correctness.push({ check: "no night below 0 or above its units", result: oversold.length === 0 ? "PASS" : `FAIL (${oversold.length})` });
  const sessionsAfterRun = await mongoose.connection.db.collection("sessions").countDocuments();
  const confirmed = await Booking.find({ status: "CONFIRMED" }).lean();
  let drift = 0;
  for (const n of nights) {
    const holding = confirmed.filter((b) => String(b.listing) === String(n.listing) && b.checkIn <= n.date && n.date < b.checkOut).length;
    if (holding !== n.reserved) drift++;
  }
  correctness.push({ check: `counters match bookings (${nights.length} nights)`, result: drift === 0 ? "PASS" : `FAIL (${drift})` });
  for (const c of checks) {
    const inDb = await Booking.countDocuments({ listing: c.listing._id, checkIn: new Date(`${day(360)}T00:00:00Z`) });
    correctness.push({
      check: `burst "${c.label}": 201s == units == bookings in DB`,
      result: c.created === c.units && inDb === c.units ? "PASS" : "FAIL",
      detail: `${c.created} x 201, ${inDb} in DB, units ${c.units}`,
    });
  }
  await mongoose.disconnect();

  // Contention cost from the app's own metrics.
  const metricsText = await (await fetch(`${BASE}/metrics`)).text();
  const writeConflicts = [...metricsText.matchAll(/mongodb_command_failures_total\{[^}]*code_name="WriteConflict"[^}]*\} (\d+)/g)].reduce(
    (s, m) => s + Number(m[1]),
    0,
  );

  // Where did the database time go? From the app's mongodb_command_duration_seconds histogram.
  const series = (name) =>
    Object.fromEntries([...metricsText.matchAll(new RegExp(`^${name}\\{command="([^"]+)"\\} ([0-9.e+-]+)$`, "gm"))].map((m) => [m[1], Number(m[2])]));
  const dbSum = series("mongodb_command_duration_seconds_sum");
  const dbCount = series("mongodb_command_duration_seconds_count");
  const dbTable = Object.keys(dbSum)
    .map((command) => ({
      command,
      calls: dbCount[command],
      "total s": +dbSum[command].toFixed(2),
      "avg ms": +((1000 * dbSum[command]) / dbCount[command]).toFixed(2),
    }))
    .sort((a, b) => b["total s"] - a["total s"])
    .slice(0, 8);
  const cpuSeconds = Number((metricsText.match(/^process_cpu_seconds_total ([0-9.]+)$/m) || [])[1]);

  server.kill();
  await rs.stop();

  console.log(`\nMachine: ${os.cpus()[0].model.trim()} x${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM, ${os.platform()} ${os.release()}, Node ${process.version}`);
  console.log(`Server: NODE_ENV=production, JSON logs at info (${logLines} lines written), single-node replica set (in-memory test mongod), same machine as the load generator.\n`);
  console.table(results);
  console.table(correctness);
  console.log(`MongoDB WriteConflict errors (retried transaction attempts) during the run: ${writeConflicts}`);
  console.log(`Session documents in MongoDB after the run: ${sessionsAfterRun} (logged-in virtual users: ${BOOKING_VUS + BURST})`);
  console.log(`Server process CPU time over the whole run: ${cpuSeconds.toFixed(1)} s`);
  console.log("Top MongoDB commands by total time (driver command monitoring):");
  console.table(dbTable);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
