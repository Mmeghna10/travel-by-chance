// Standalone background worker (same codebase as the web server, different
// entrypoint). Use it when web instances run with RUN_EXPIRY_WORKER=false.
const { config, assertRequired } = require("./config/env.js");
const mongoose = require("mongoose");
const { ensureIndexes } = require("./modules/bookings/service.js");
const { startExpiryWorker } = require("./modules/bookings/expiryWorker.js");

async function start() {
  assertRequired();
  await mongoose.connect(config.dbUrl, { serverSelectionTimeoutMS: 10_000 });
  await ensureIndexes();
  const worker = startExpiryWorker({ intervalMs: config.expiryIntervalMs });
  console.log(`worker started (expiry every ${config.expiryIntervalMs / 1000}s)`);

  // unref()'d timers alone would let the process exit; keep it alive.
  const keepAlive = setInterval(() => {}, 1 << 30);

  const shutdown = async (signal) => {
    console.log(`${signal} received, stopping worker`);
    clearInterval(keepAlive);
    await worker.stop(); // let an in-flight expiry run finish
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  console.error("Worker failed to start:", err.message);
  process.exit(1);
});
