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
  port: Number(process.env.PORT) || 8080,
  dbUrl: process.env.ATLASDB_URL,
  sessionSecret: process.env.SECRET,
  // Number of reverse proxies in front of the app (needed for correct client
  // IPs in rate limiting and for secure cookies behind HTTPS termination).
  trustProxy: Number(process.env.TRUST_PROXY) || 0,
  bookings: {
    // When true, new bookings start as PENDING_PAYMENT and hold their nights
    // for holdMinutes. Stays false until online payment exists (Milestone 4).
    requirePayment: process.env.REQUIRE_PAYMENT === "true",
    holdMinutes: Number(process.env.BOOKING_HOLD_MINUTES) || 15,
  },
  // Run the expiry worker inside each web process (simplest deployment).
  // Set RUN_EXPIRY_WORKER=false when running worker.js separately.
  runExpiryWorker: process.env.RUN_EXPIRY_WORKER !== "false",
  expiryIntervalMs: (Number(process.env.EXPIRY_INTERVAL_SECONDS) || 30) * 1000,
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
