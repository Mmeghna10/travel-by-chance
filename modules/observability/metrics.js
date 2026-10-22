// Prometheus metrics (prom-client), exposed at GET /metrics.
//
// Logs answer "what happened to THIS request?"; metrics answer "how is the
// SYSTEM doing?" (rates, error ratios, latency percentiles) cheaply and over
// time. Labels are kept low-cardinality (route templates like
// /listings/:id, never raw ids or user ids), otherwise every distinct value
// becomes a new time series.
const client = require("prom-client");

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry }); // CPU, memory, event-loop lag, GC, handles

const metric = (Type, config) => new Type({ ...config, registers: [registry] });

const httpRequestDuration = metric(client.Histogram, {
  name: "http_request_duration_seconds",
  help: "HTTP request latency by route template",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

const bookingAttempts = metric(client.Counter, {
  name: "booking_attempts_total",
  help: "Booking requests by outcome (created, replayed, sold_out, invalid, error)",
  labelNames: ["outcome"],
});

const inventoryConflicts = metric(client.Counter, {
  name: "booking_inventory_conflicts_total",
  help: "Booking attempts rejected because a night had no units left",
});

const bookingTransitions = metric(client.Counter, {
  name: "booking_transitions_total",
  help: "Booking status changes",
  labelNames: ["from", "to", "actor"],
});

const paymentOutcomes = metric(client.Counter, {
  name: "payment_outcomes_total",
  help: "Results of applying a Razorpay payment, by where we learned about it",
  labelNames: ["source", "outcome"],
});

const webhookDeliveries = metric(client.Counter, {
  name: "webhook_deliveries_total",
  help: "Razorpay webhook deliveries",
  labelNames: ["event", "result"],
});

const refundOutcomes = metric(client.Counter, {
  name: "refund_outcomes_total",
  help: "Refund submissions and outcomes",
  labelNames: ["outcome"],
});

const jobDuration = metric(client.Histogram, {
  name: "background_job_duration_seconds",
  help: "Duration of background job passes",
  labelNames: ["job", "result"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60],
});

const dbCommandDuration = metric(client.Histogram, {
  name: "mongodb_command_duration_seconds",
  help: "MongoDB command latency (from driver command monitoring)",
  labelNames: ["command"],
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

const dbCommandFailures = metric(client.Counter, {
  name: "mongodb_command_failures_total",
  help: "Failed MongoDB commands by error code name (WriteConflict = transaction contention)",
  labelNames: ["command", "code_name"],
});

const cacheRequests = metric(client.Counter, {
  name: "cache_requests_total",
  help: "Listing cache lookups by result (hit, miss, error, bypass = Redis unavailable)",
  labelNames: ["cache", "result"],
});

const redisErrors = metric(client.Counter, {
  name: "redis_errors_total",
  help: "Redis client errors (connection drops, failed reconnects)",
});

const rateLimitStoreFallbacks = metric(client.Counter, {
  name: "rate_limit_store_fallbacks_total",
  help: "Rate-limit checks counted in process memory because Redis was unavailable",
  labelNames: ["limiter"],
});

// Records the mount path of the router handling the request. Express resets
// req.baseUrl when a router exits (e.g. after a handler calls next(err)), so
// it can't be read reliably once the response has finished.
function routeBase(base) {
  return (req, res, next) => {
    req.metricsRouteBase = base;
    next();
  };
}

// Express route template for the metrics label, e.g. "/listings/:id". Requests
// that matched no route share one label, so bots probing random URLs can't
// create unbounded label values.
function routeLabel(req) {
  if (!req.route) return "unmatched";
  const path = (req.metricsRouteBase || "") + (req.route.path === "/" ? "" : req.route.path);
  return path || "/";
}

function httpMetrics(req, res, next) {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    end({ method: req.method, route: routeLabel(req), status_code: res.statusCode });
  });
  next();
}

module.exports = {
  registry,
  httpMetrics,
  routeBase,
  bookingAttempts,
  inventoryConflicts,
  bookingTransitions,
  paymentOutcomes,
  webhookDeliveries,
  refundOutcomes,
  jobDuration,
  dbCommandDuration,
  dbCommandFailures,
  cacheRequests,
  redisErrors,
  rateLimitStoreFallbacks,
};
