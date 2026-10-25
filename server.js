// Process entrypoint: load config, connect to MongoDB, start HTTP, shut down cleanly.
const { config, assertRequired } = require("./config/env.js");
const mongoose = require("mongoose");
const { createApp } = require("./app.js");
const { ensureIndexes } = require("./modules/bookings/service.js");
const { startBackgroundJobs } = require("./modules/jobs/runner.js");
const { configurePayments, paymentsEnabled, paymentsMode, paymentsLive } = require("./modules/payments/gateway.js");
const { logger } = require("./modules/observability/logger.js");
const { installProcessHandlers, reportError } = require("./modules/observability/errors.js");
const { instrumentMongo } = require("./modules/observability/db.js");
const { configureMail, mailEnabled } = require("./modules/notifications/mailer.js");
const { connectRedis, closeRedis } = require("./modules/cache/redis.js");

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function start() {
  installProcessHandlers();
  assertRequired();
  configurePayments(config.payments); // throws on live keys unless explicitly allowed
  configureMail(config.mail);
  logger.info({ email: mailEnabled() ? "on" : "off" }, mailEnabled() ? "booking emails: on (SMTP)" : "booking emails: off (set SMTP_USER and SMTP_PASS)");
  if (config.bookings.requirePayment && !paymentsEnabled()) {
    throw new Error("REQUIRE_PAYMENT=true needs Razorpay keys (or DEMO_PAYMENTS=true); bookings could never be paid.");
  }
  if (paymentsLive()) {
    const missing = ["email", "phone", "address"].filter((k) => !config.business[k]);
    if (missing.length) {
      throw new Error(
        `Live payments need real contact details on the site: set ${missing.map((k) => ({ email: "SUPPORT_EMAIL", phone: "SUPPORT_PHONE", address: "BUSINESS_ADDRESS" })[k]).join(", ")}.`,
      );
    }
  }
  const mode = paymentsMode();
  const describe = {
    razorpay: paymentsLive() ? "payments: Razorpay LIVE (real money)" : "payments: Razorpay (test mode)",
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
  // Optional: waits briefly, then continues without Redis if it isn't up.
  await connectRedis(config.redisUrl);
  logger.info({ redis: config.redisUrl ? "configured" : "off" }, config.redisUrl ? "redis: shared rate limits + listing cache" : "redis: off (per-process rate limits, no cache)");

  const app = createApp({
    sessionSecret: config.sessionSecret,
    httpsOnly: config.httpsOnly,
    trustProxy: config.trustProxy,
    bookings: config.bookings,
    metricsToken: config.metricsToken,
    rateLimit: config.rateLimit,
    business: config.business,
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
      await closeRedis();
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
