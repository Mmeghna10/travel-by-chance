// Process entrypoint: load config, connect to MongoDB, start HTTP, shut down cleanly.
const { config, assertRequired } = require("./config/env.js");
const mongoose = require("mongoose");
const { createApp } = require("./app.js");
const { ensureIndexes } = require("./modules/bookings/service.js");
const { startBackgroundJobs } = require("./modules/jobs/runner.js");
const { configurePayments, paymentsEnabled } = require("./modules/payments/gateway.js");

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function start() {
  assertRequired();
  configurePayments(config.payments); // throws on live keys unless explicitly allowed
  if (config.bookings.requirePayment && !paymentsEnabled()) {
    throw new Error("REQUIRE_PAYMENT=true needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET; bookings could never be paid.");
  }
  console.log(paymentsEnabled() ? "payments: Razorpay (test mode)" : "payments: disabled (bookings confirm instantly)");

  // Fail fast: don't accept traffic we can't serve.
  await mongoose.connect(config.dbUrl, { serverSelectionTimeoutMS: 10_000 });
  console.log("connected to database");
  // Booking correctness depends on unique indexes; build them before serving.
  await ensureIndexes();

  const app = createApp({
    sessionSecret: config.sessionSecret,
    isProduction: config.isProduction,
    trustProxy: config.trustProxy,
    bookings: config.bookings,
  });

  const worker = config.runBackgroundJobs ? startBackgroundJobs({ intervalMs: config.jobIntervalMs }) : null;

  const server = app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);

    // Hard stop if in-flight requests don't finish in time.
    setTimeout(() => {
      console.error("Forced shutdown after timeout");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    // Stop accepting new connections, let in-flight requests finish, then close the DB.
    server.close(async () => {
      if (worker) await worker.stop();
      await Promise.allSettled([app.get("sessionStore").collectionP]);
      await mongoose.disconnect();
      console.log("Shutdown complete");
      process.exit(0);
    });
    server.closeIdleConnections();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});
