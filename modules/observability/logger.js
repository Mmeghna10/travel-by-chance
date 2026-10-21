// Structured JSON logging (pino) with a request ID on every line.
//
// One JSON object per line is what log platforms (Loki, CloudWatch, Datadog,
// ELK) index: you can filter by reqId, level, bookingId, ... instead of
// grepping free text. The request ID is stored in AsyncLocalStorage, so any
// log written anywhere while handling a request (deep inside a service, a
// payment module, ...) carries the same reqId without passing it around.
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const pino = require("pino");

const context = new AsyncLocalStorage();

// Never log these. Paths are pino "redact" syntax; values become "[REDACTED]".
const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-razorpay-signature"]',
  'res.headers["set-cookie"]',
  "password",
  "*.password",
  "razorpay_signature",
  "*.razorpay_signature",
  "*.keySecret",
  "*.key_secret",
  "*.webhookSecret",
];

// In tests, log lines go to an in-memory array (silent unless a test raises
// the level) so tests can assert on what is and isn't logged.
// NODE_TEST_CONTEXT is set by node --test in every test process, whatever the
// order in which modules are loaded.
const isTest = process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
const capturedLogs = [];
const testDestination = { write: (line) => capturedLogs.push(JSON.parse(line)) };

const logger = pino({
  level: process.env.LOG_LEVEL || (isTest ? "silent" : "info"),
  base: { service: process.env.SERVICE_NAME || "travelbychance" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  // Adds the current request's ID to every log line written during that request.
  mixin() {
    const store = context.getStore();
    return store ? { reqId: store.reqId } : {};
  },
  // Human-readable output for local development only (pino-pretty is a dev dependency).
  transport: !isTest && process.env.LOG_PRETTY === "true" ? { target: "pino-pretty", options: { singleLine: true } } : undefined,
}, isTest ? testDestination : undefined);

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Express middleware: accepts a well-formed incoming X-Request-Id (e.g. from a
 * load balancer, so one ID spans proxy -> app logs) or generates one, echoes it
 * in the response, and makes it the logging context for the whole request.
 */
function requestContext(req, res, next) {
  const incoming = req.get("x-request-id");
  const reqId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
  req.id = reqId;
  res.set("X-Request-Id", reqId);
  context.run({ reqId }, next);
}

/** Runs `fn` with its own correlation ID, e.g. one background job pass. */
function withContext(reqId, fn) {
  return context.run({ reqId }, fn);
}

module.exports = { logger, requestContext, withContext, REDACT_PATHS, capturedLogs };
