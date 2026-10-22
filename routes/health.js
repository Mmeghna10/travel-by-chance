const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { getRedis, isRedisReady } = require("../modules/cache/redis.js");

// Redis is optional (cache + shared rate limits), so it's reported but never
// makes the instance "not ready": without it the app is slower, not broken.
const redisStatus = () => (!getRedis() ? "off" : isRedisReady() ? "ok" : "down");

// Liveness: the process is up and the event loop responds. Never checks
// dependencies, so a DB outage doesn't make an orchestrator restart every instance.
router.get("/healthz", (req, res) => {
  res.json({ status: "ok" });
});

// Readiness: this instance can serve traffic (DB connected). Load balancers
// should stop routing here while it returns 503.
router.get("/readyz", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ status: "unavailable", db: "disconnected", redis: redisStatus() });
  }
  try {
    await mongoose.connection.db.admin().ping();
    res.json({ status: "ready", db: "ok", redis: redisStatus() });
  } catch (err) {
    res.status(503).json({ status: "unavailable", db: "ping failed", redis: redisStatus() });
  }
});

module.exports = router;
