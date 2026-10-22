// Loads environment configuration once, for the server and the init/ scripts.
const dns = require("dns");

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config({ quiet: true });
}

// Some networks can't resolve Atlas "mongodb+srv" records with the default
// resolver. Set DNS_SERVERS=8.8.8.8,8.8.4.4 to override; leave it unset in
// Docker so container hostnames (e.g. "mongo") still resolve.
if (process.env.DNS_SERVERS) {
  dns.setServers(process.env.DNS_SERVERS.split(",").map((s) => s.trim()));
}

const config = {
  env: process.env.NODE_ENV || "development",
  isProduction: process.env.NODE_ENV === "production",
  // Whether users reach the site over HTTPS. Separate from NODE_ENV so the
  // production image can run over plain http://localhost in Docker (where
  // Secure cookies would never be set and login would silently fail).
  httpsOnly:
    process.env.HTTPS_ONLY !== undefined ? process.env.HTTPS_ONLY === "true" : process.env.NODE_ENV === "production",
  port: Number(process.env.PORT) || 8080,
  dbUrl: process.env.ATLASDB_URL,
  sessionSecret: process.env.SECRET,
  // Number of reverse proxies in front of the app (needed for correct client
  // IPs in rate limiting and for secure cookies behind HTTPS termination).
  trustProxy: Number(process.env.TRUST_PROXY) || 0,
  metricsToken: process.env.METRICS_TOKEN || undefined,
  // Per-IP login/signup attempts per 15 min, per-user booking attempts per minute.
  // Raised only for load tests; keep the defaults in real deployments.
  rateLimit: {
    authMax: Number(process.env.RATE_LIMIT_AUTH_MAX) || undefined,
    bookingMax: Number(process.env.RATE_LIMIT_BOOKING_MAX) || undefined,
  },
  payments: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    // Optional locally (webhooks can't reach localhost without a tunnel);
    // reconciliation catches up on payments without it.
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    allowLive: process.env.ALLOW_LIVE_PAYMENTS === "true",
  },
  bookings: {
    // When true, new bookings start as PENDING_PAYMENT and hold their nights
    // for holdMinutes until paid. Defaults to on when Razorpay keys are set.
    requirePayment:
      process.env.REQUIRE_PAYMENT !== undefined
        ? process.env.REQUIRE_PAYMENT === "true"
        : Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
    holdMinutes: Number(process.env.BOOKING_HOLD_MINUTES) || 15,
  },
  // Run background jobs (hold expiry, refunds, reconciliation) inside each
  // web process (simplest deployment). Set RUN_BACKGROUND_JOBS=false when
  // running worker.js separately. RUN_EXPIRY_WORKER is the Milestone 3 name.
  runBackgroundJobs: (process.env.RUN_BACKGROUND_JOBS ?? process.env.RUN_EXPIRY_WORKER) !== "false",
  jobIntervalMs: (Number(process.env.JOB_INTERVAL_SECONDS ?? process.env.EXPIRY_INTERVAL_SECONDS) || 30) * 1000,
};

function assertRequired() {
  const missing = [];
  if (!config.dbUrl) missing.push("ATLASDB_URL");
  if (!config.sessionSecret) missing.push("SECRET");
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

module.exports = { config, assertRequired };
