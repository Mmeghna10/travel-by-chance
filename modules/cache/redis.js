// Optional Redis connection, used for two things only:
//   1. shared rate-limit counters (so limits hold across several web instances)
//   2. a short-lived cache of listing reads (browse page, landing page, search box)
//
// Redis is NEVER the source of truth. Bookings, inventory, payments and
// sessions live in MongoDB; losing every Redis key loses nothing but speed.
// So the app treats Redis as optional: with REDIS_URL unset, or while Redis
// is down, rate limits fall back to per-process memory and reads go straight
// to MongoDB.
const { createClient } = require("redis");
const { logger } = require("../observability/logger.js");
const { redisErrors } = require("../observability/metrics.js");

let client = null;
let lastErrorLog = 0;

/**
 * Connects if url is set. Waits up to startupWaitMs for the first connection,
 * then carries on either way: the client keeps reconnecting in the background,
 * and callers check isRedisReady() before every use.
 */
async function connectRedis(url, { startupWaitMs = 5000 } = {}) {
  if (!url) return null;
  const c = createClient({
    url,
    // Fail commands immediately while disconnected instead of queueing them;
    // a queued rate-limit check would hold the request until Redis came back.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 3000,
      // Back off up to 5 s between reconnect attempts, forever.
      reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 5000),
    },
  });
  c.on("error", (err) => {
    redisErrors.inc();
    // Every failed reconnect emits an error; log at most one every 30 s.
    if (Date.now() - lastErrorLog > 30_000) {
      lastErrorLog = Date.now();
      logger.warn({ err: err.message }, "redis unavailable; using per-process rate limits and no cache");
    }
  });
  c.on("ready", () => logger.info("redis connected"));
  client = c;

  const connected = c.connect().then(
    () => true,
    () => false, // only rejects if reconnecting is given up, which ours never does
  );
  const timeout = new Promise((resolve) => setTimeout(resolve, startupWaitMs, false).unref());
  if (!(await Promise.race([connected, timeout]))) {
    logger.warn({ startupWaitMs }, "redis not reachable at startup; continuing without it, will keep retrying");
  }
  return c;
}

function getRedis() {
  return client;
}

function isRedisReady() {
  return Boolean(client && client.isReady);
}

/** For tests: use a given client (real or fake) instead of connecting. */
function setRedisClient(c) {
  client = c;
}

async function closeRedis() {
  if (!client) return;
  const c = client;
  client = null;
  try {
    if (c.isOpen) await c.quit();
  } catch {
    c.destroy?.();
  }
}

/** Rejects if a Redis call takes longer than ms (a hung Redis must not hang requests). */
function withTimeout(promise, ms = 200) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`redis call timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

module.exports = { connectRedis, getRedis, isRedisReady, setRedisClient, closeRedis, withTimeout };
