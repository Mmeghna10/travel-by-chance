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

const PASSWORD = "correct-horse-battery";
let replSet;

async function startDb() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri());
}

async function stopDb() {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}

async function resetDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

function buildApp(rateLimit = {}) {
  // High defaults so only the rate-limit tests ever hit a limit.
  return createApp({ sessionSecret: "test-secret", rateLimit: { authMax: 1000, bookingMax: 1000, ...rateLimit } });
}

async function createUser(username, role = "customer") {
  return User.register(new User({ username, email: `${username}@example.com`, role }), PASSWORD);
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

module.exports = { startDb, stopDb, resetDb, buildApp, createUser, loginAgent, createListing, request, PASSWORD };
