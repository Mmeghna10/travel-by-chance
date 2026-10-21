// Error tracking hook. Every unexpected error goes through reportError(),
// which logs it (with stack and request ID) and forwards it to any registered
// reporters. To plug in a service like Sentry later, call
// addErrorReporter((err, ctx) => Sentry.captureException(err, { extra: ctx }))
// at startup. Nothing else in the app needs to change.
const { logger } = require("./logger.js");

const reporters = [];

function addErrorReporter(fn) {
  reporters.push(fn);
}

function reportError(err, ctx = {}) {
  logger.error({ err, ...ctx }, ctx.message || err.message || "unexpected error");
  for (const report of reporters) {
    try {
      report(err, ctx);
    } catch (reporterErr) {
      logger.error({ err: reporterErr }, "error reporter failed");
    }
  }
}

// Last-resort handlers. After an uncaught exception the process state is
// unknown, so we log and exit; the container/platform restarts us.
function installProcessHandlers() {
  process.on("unhandledRejection", (reason) => {
    reportError(reason instanceof Error ? reason : new Error(String(reason)), { message: "unhandled promise rejection" });
  });
  process.on("uncaughtException", (err) => {
    reportError(err, { message: "uncaught exception, exiting" });
    logger.flush?.();
    process.exit(1);
  });
}

module.exports = { reportError, addErrorReporter, installProcessHandlers };
