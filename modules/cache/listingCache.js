// Cache-aside for read-heavy listing queries (browse page, landing page,
// search suggestions), stored in Redis as JSON.
//
// Invalidation by GENERATION number instead of deleting keys: every key
// includes the current value of "tbc:listings:gen", and any listing write
// increments it (see the hooks in models/listing.js). Old keys are never read
// again and expire on their own. This avoids having to know which of many
// cached searches a given listing appears in.
//
// What is cached is display data only. Booking prices and availability are
// always computed from MongoDB at booking time, never from this cache, so a
// stale entry can show an old card but can't sell a room at a wrong price.
//
// Staleness bound: if Redis is unreachable when a listing changes, the
// generation can't be bumped; entries then expire after TTL_SECONDS.
const crypto = require("crypto");
const { getRedis, isRedisReady, withTimeout } = require("./redis.js");
const { cacheRequests } = require("../observability/metrics.js");
const { logger } = require("../observability/logger.js");

const PREFIX = "tbc:listings";
const GEN_KEY = `${PREFIX}:gen`;
const TTL_SECONDS = 60;

const keyFor = (gen, name, params) =>
  `${PREFIX}:${gen}:${name}:${crypto.createHash("sha1").update(JSON.stringify(params)).digest("hex")}`;

/**
 * Returns the cached value for (name, params), or calls load(), caches its
 * result and returns it. load() must return plain JSON-serialisable data.
 * Any Redis problem means "load from MongoDB", never an error page.
 */
async function cachedListings(name, params, load) {
  if (!isRedisReady()) {
    cacheRequests.inc({ cache: name, result: "bypass" });
    return load();
  }
  const redis = getRedis();
  let key;
  try {
    const gen = (await withTimeout(redis.get(GEN_KEY))) || "0";
    key = keyFor(gen, name, params);
    const hit = await withTimeout(redis.get(key));
    if (hit !== null && hit !== undefined) {
      cacheRequests.inc({ cache: name, result: "hit" });
      return JSON.parse(hit);
    }
  } catch (err) {
    cacheRequests.inc({ cache: name, result: "error" });
    logger.warn({ err: err.message, cache: name }, "cache read failed; reading from database");
    return load();
  }
  cacheRequests.inc({ cache: name, result: "miss" });
  const value = await load();
  // Don't make the user wait for the write, and don't fail if it fails.
  withTimeout(redis.set(key, JSON.stringify(value), { EX: TTL_SECONDS })).catch((err) =>
    logger.warn({ err: err.message, cache: name }, "cache write failed"),
  );
  return value;
}

/** Called after any listing write. Never throws: the write already succeeded. */
async function invalidateListings() {
  if (!isRedisReady()) return;
  try {
    await withTimeout(getRedis().incr(GEN_KEY));
  } catch (err) {
    logger.warn({ err: err.message }, `listing cache invalidation failed; entries expire within ${TTL_SECONDS}s`);
  }
}

module.exports = { cachedListings, invalidateListings, TTL_SECONDS, GEN_KEY };
