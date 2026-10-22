const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

// Liveness: the process is up and the event loop responds. Never checks
// dependencies, so a DB outage doesn't make an orchestrator restart every instance.
router.get("/healthz", (req, res) => {
  res.json({ status: "ok" });
});

// Readiness: this instance can serve traffic (DB connected). Load balancers
// should stop routing here while it returns 503.
router.get("/readyz", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ status: "unavailable", db: "disconnected" });
  }
  try {
    await mongoose.connection.db.admin().ping();
    res.json({ status: "ready", db: "ok" });
  } catch (err) {
    res.status(503).json({ status: "unavailable", db: "ping failed" });
  }
});

module.exports = router;
