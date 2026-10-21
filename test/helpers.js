// Shared test setup: a real mongod (single-node replica set, so transactions
// work like on Atlas) started per test file, plus helpers for users/listings.
process.env.NODE_ENV = "test";
// The Mapbox SDK validates the token's shape at startup; no request is made in tests.
process.env.MAP_TOKEN = process.env.MAP_TOKEN || "pk.eyJ1IjoidGVzdCJ9.test";

const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { createApp } = require("../app.js");
const User = require("../models/user.js");
const Listing = require("../models/listing.js");
const { ensureIndexes } = require("../modules/bookings/service.js");
const { todayIn, formatDay, DAY_MS } = require("../modules/bookings/dates.js");

const PASSWORD = "correct-horse-battery";
let replSet;
const apps = [];

async function startDb() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri());
  await ensureIndexes();
}

async function stopDb() {
  // Let each session store finish creating its index before the client closes,
  // otherwise that background work fails with "client was closed".
  await Promise.allSettled(apps.map((a) => a.get("sessionStore").collectionP));
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}

async function resetDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

function buildApp(rateLimit = {}, bookings = {}, options = {}) {
  // High defaults so only the rate-limit tests ever hit a limit.
  const app = createApp({
    ...options,
    sessionSecret: "test-secret",
    rateLimit: { authMax: 1000, bookingMax: 1000, ...rateLimit },
    bookings,
  });
  apps.push(app);
  return app;
}

async function createUser(username, role = "customer") {
  return User.register(new User({ username, email: `${username}@example.com`, role }), PASSWORD);
}

// "YYYY-MM-DD" n days after today (in the booking time zone).
function day(n) {
  return formatDay(new Date(todayIn().getTime() + n * DAY_MS));
}

// A single real HTTP server, so concurrent requests share one process like
// production instead of supertest spinning up a server per request.
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function newKey() {
  return require("crypto").randomUUID();
}

async function loginAgent(app, username) {
  const agent = request.agent(app);
  const res = await agent.post("/login").type("form").send({ username, password: PASSWORD });
  if (res.status !== 302 || res.headers.location === "/login") {
    throw new Error(`login failed for ${username}: ${res.status} -> ${res.headers.location}`);
  }
  return agent;
}

async function createListing(owner, overrides = {}) {
  return Listing.create({
    title: "Test Cabin",
    description: "A quiet cabin",
    image: { url: "https://res.cloudinary.com/demo/image/upload/sample.jpg", filename: "sample" },
    price: 1000,
    location: "Manali",
    country: "India",
    category: "Mountains",
    owner: owner._id,
    geometry: { type: "Point", coordinates: [77.19, 32.24] },
    ...overrides,
  });
}

module.exports = {
  startDb,
  stopDb,
  resetDb,
  buildApp,
  createUser,
  loginAgent,
  createListing,
  request,
  PASSWORD,
  day,
  listen,
  newKey,
};
