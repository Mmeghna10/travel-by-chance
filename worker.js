// Standalone background worker (same codebase as the web server, different
// entrypoint). Use it when web instances run with RUN_BACKGROUND_JOBS=false.
const { config, assertRequired } = require("./config/env.js");
const mongoose = require("mongoose");
const { ensureIndexes } = require("./modules/bookings/service.js");
const { startBackgroundJobs } = require("./modules/jobs/runner.js");
const { configurePayments } = require("./modules/payments/gateway.js");

async function start() {
  assertRequired();
  configurePayments(config.payments);
  await mongoose.connect(config.dbUrl, { serverSelectionTimeoutMS: 10_000 });
  await ensureIndexes();
  const worker = startBackgroundJobs({ intervalMs: config.jobIntervalMs });

  // unref()'d timers alone would let the process exit; keep it alive.
  const keepAlive = setInterval(() => {}, 1 << 30);

  const shutdown = async (signal) => {
    console.log(`${signal} received, stopping worker`);
    clearInterval(keepAlive);
    await worker.stop(); // let an in-flight pass finish
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
