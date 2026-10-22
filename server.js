// Process entrypoint: load config, connect to MongoDB, start HTTP, shut down cleanly.
const { config, assertRequired } = require("./config/env.js");
const mongoose = require("mongoose");
const { createApp } = require("./app.js");
const { ensureIndexes } = require("./modules/bookings/service.js");
const { startBackgroundJobs } = require("./modules/jobs/runner.js");
const { configurePayments, paymentsEnabled, paymentsMode } = require("./modules/payments/gateway.js");
const { logger } = require("./modules/observability/logger.js");
const { installProcessHandlers, reportError } = require("./modules/observability/errors.js");
const { instrumentMongo } = require("./modules/observability/db.js");

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function start() {
  installProcessHandlers();
  assertRequired();
  configurePayments(config.payments); // throws on live keys unless explicitly allowed
  if (config.bookings.requirePayment && !paymentsEnabled()) {
    throw new Error("REQUIRE_PAYMENT=true needs Razorpay keys (or DEMO_PAYMENTS=true); bookings could never be paid.");
  }
  const mode = paymentsMode();
  const describe = {
    razorpay: "payments: Razorpay (test mode)",
    demo: "payments: DEMO mode (simulated gateway, no real money)",
  };
  logger.info({ payments: mode || "disabled" }, describe[mode] || "payments: disabled (bookings confirm instantly)");

  // Fail fast: don't accept traffic we can't serve.
  // monitorCommands: emit per-command events for query metrics / slow-query logs.
  await mongoose.connect(config.dbUrl, { serverSelectionTimeoutMS: 10_000, monitorCommands: true });
  instrumentMongo(mongoose.connection);
  logger.info("connected to database");
  // Booking correctness depends on unique indexes; build them before serving.
  await ensureIndexes();

  const app = createApp({
    sessionSecret: config.sessionSecret,
    httpsOnly: config.httpsOnly,
    trustProxy: config.trustProxy,
    bookings: config.bookings,
    metricsToken: config.metricsToken,
    rateLimit: config.rateLimit,
  });

  const worker = config.runBackgroundJobs ? startBackgroundJobs({ intervalMs: config.jobIntervalMs }) : null;

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, `Server running on port ${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, `${signal} received, shutting down`);

    // Hard stop if in-flight requests don't finish in time.
    setTimeout(() => {
      logger.error("Forced shutdown after timeout");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    // Stop accepting new connections, let in-flight requests finish, then close the DB.
    server.close(async () => {
      if (worker) await worker.stop();
      await Promise.allSettled([app.get("sessionStore").collectionP]);
      await mongoose.disconnect();
      logger.info("Shutdown complete");
      process.exit(0);
    });
    server.closeIdleConnections();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  reportError(err, { message: "failed to start" });
  process.exit(1);
});
