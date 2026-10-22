// Rate-limit store that counts in Redis when it can and in process memory
// when it can't.
//
// Why Redis: with several web instances behind a load balancer, in-memory
// counters are per instance, so "10 login attempts" really means 10 × the
// number of instances. A shared Redis counter makes the limit global.
//
// Why the fallback: Redis is optional (see modules/cache/redis.js). If it's
// down, failing CLOSED would lock everyone out of login and booking, and
// failing OPEN would remove brute-force protection entirely. Falling back to
// per-process counting keeps a (looser) limit in place until Redis returns.
const { MemoryStore } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const { getRedis, isRedisReady, withTimeout } = require("../modules/cache/redis.js");
const { rateLimitStoreFallbacks } = require("../modules/observability/metrics.js");
const { logger } = require("../modules/observability/logger.js");

const REINIT_AFTER_MS = 5000;

class RedisWithMemoryFallback {
  constructor(name) {
    this.name = name;
    this.prefix = `tbc:rl:${name}:`;
    this.memory = new MemoryStore();
    this.redis = null; // created lazily, once a Redis client exists
    this.redisInit = null; // promise: scripts loaded
    this.lastInitAttempt = 0;
  }

  init(options) {
    this.options = options;
    this.memory.init(options);
  }

  // Loads (or reloads, after a failure) the Lua scripts rate-limit-redis uses.
  ensureRedisStore() {
    const client = getRedis();
    if (!this.redis || this.client !== client) {
      this.client = client;
      this.redis = new RedisStore({ prefix: this.prefix, sendCommand: (...args) => client.sendCommand(args) });
      this.redisInit = null;
    }
    if (!this.redisInit && Date.now() - this.lastInitAttempt > REINIT_AFTER_MS) {
      this.lastInitAttempt = Date.now();
      this.redisInit = this.redis.init(this.options).catch((err) => {
        this.redisInit = null; // retry later
        throw err;
      });
    }
    return this.redisInit;
  }

  async useRedis(op) {
    if (!isRedisReady()) return null;
    const ready = this.ensureRedisStore();
    if (!ready) return null; // a recent init failed; don't retry on every request
    try {
      await withTimeout(ready);
      return { value: await withTimeout(op(this.redis)) };
    } catch (err) {
      logger.warn({ err: err.message, limiter: this.name }, "rate limit: redis failed, counting in memory");
      return null;
    }
  }

  async increment(key) {
    const r = await this.useRedis((s) => s.increment(key));
    if (r) return r.value;
    rateLimitStoreFallbacks.inc({ limiter: this.name });
    return this.memory.increment(key);
  }

  async decrement(key) {
    const r = await this.useRedis((s) => s.decrement(key));
    if (!r) await this.memory.decrement(key);
  }

  async resetKey(key) {
    await this.useRedis((s) => s.resetKey(key));
    await this.memory.resetKey(key);
  }

  async get(key) {
    const r = await this.useRedis((s) => s.get(key));
    return r ? r.value : this.memory.get(key);
  }

  shutdown() {
    this.memory.shutdown();
  }
}

module.exports = { RedisWithMemoryFallback };
