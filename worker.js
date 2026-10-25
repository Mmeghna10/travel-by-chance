// Standalone background worker (same codebase as the web server, different
// entrypoint). Use it when web instances run with RUN_BACKGROUND_JOBS=false.
const { config, assertRequired } = require("./config/env.js");
const http = require("http");
const mongoose = require("mongoose");
const { registry } = require("./modules/observability/metrics.js");
const { ensureIndexes } = require("./modules/bookings/service.js");
const { startBackgroundJobs } = require("./modules/jobs/runner.js");
const { configurePayments } = require("./modules/payments/gateway.js");
const { logger } = require("./modules/observability/logger.js");
const { installProcessHandlers, reportError } = require("./modules/observability/errors.js");
const { instrumentMongo } = require("./modules/observability/db.js");
const { configureMail, mailEnabled } = require("./modules/notifications/mailer.js");

async function start() {
  installProcessHandlers();
  assertRequired();
  configurePayments(config.payments);
  configureMail(config.mail);
  logger.info({ email: mailEnabled() ? "on" : "off" }, mailEnabled() ? "booking emails: on (SMTP)" : "booking emails: off (set SMTP_USER and SMTP_PASS)");
  await mongoose.connect(config.dbUrl, { serverSelectionTimeoutMS: 10_000, monitorCommands: true });
  instrumentMongo(mongoose.connection);
  await ensureIndexes();
  const worker = startBackgroundJobs({ intervalMs: config.jobIntervalMs });

  // Tiny HTTP server so the worker can be health-checked and scraped like the
  // web app (it has no Express app of its own). Not published by compose.
  const metricsPort = Number(process.env.WORKER_METRICS_PORT) || 9464;
  const metricsServer = http
    .createServer(async (req, res) => {
      if (req.url === "/healthz") return res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
      if (req.url === "/metrics") {
        const token = config.metricsToken;
        if (token && req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
        return res.writeHead(200, { "Content-Type": registry.contentType }).end(await registry.metrics());
      }
      res.writeHead(404).end();
    })
    .listen(metricsPort, () => logger.info({ port: metricsPort }, "worker metrics listening"));

  // unref()'d timers alone would let the process exit; keep it alive.
  const keepAlive = setInterval(() => {}, 1 << 30);

  const shutdown = async (signal) => {
    logger.info({ signal }, `${signal} received, stopping worker`);
    clearInterval(keepAlive);
    metricsServer.close();
    await worker.stop(); // let an in-flight pass finish
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  reportError(err, { message: "worker failed to start" });
  process.exit(1);
});
