const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { RedisWithMemoryFallback } = require("./rateLimitStore.js");

const onlyPosts = (req) => req.method !== "POST";

// Slows down password guessing and signup spam. Counted per client IP.
module.exports.createAuthLimiter = (limit = 10) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    skip: onlyPosts,
    // Shared across instances via Redis when available (see rateLimitStore.js).
    store: new RedisWithMemoryFallback("auth"),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).render("error.ejs", { message: "Too many attempts. Please try again in a few minutes." });
    },
  });

// Caps booking attempts per logged-in user (falls back to IP when anonymous).
module.exports.createBookingLimiter = (limit = 20) =>
  rateLimit({
    windowMs: 60 * 1000,
    limit,
    skip: onlyPosts,
    store: new RedisWithMemoryFallback("booking"),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => (req.user ? `user:${req.user._id}` : ipKeyGenerator(req.ip)),
    message: { success: false, message: "Too many booking attempts. Please slow down." },
  });
