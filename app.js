// Builds the Express application. It does not connect to the database or
// listen on a port (server.js does that), so tests can create isolated apps.
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");
const helmet = require("helmet");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const flash = require("connect-flash");
const passport = require("passport");
const LocalStrategy = require("passport-local");
const crypto = require("crypto");
const pinoHttp = require("pino-http");
const { logger, requestContext } = require("./modules/observability/logger.js");
const { registry, httpMetrics, routeBase } = require("./modules/observability/metrics.js");
const { reportError } = require("./modules/observability/errors.js");

const ExpressError = require("./utils/ExpressError.js");
const wrapAsync = require("./utils/wrapAsync.js");
const safeJson = require("./utils/safeJson.js");
const { createAuthLimiter, createBookingLimiter } = require("./middleware/rateLimits.js");
const { formatPaise } = require("./modules/bookings/pricing.js");
const User = require("./models/user.js");

const listingRouter = require("./routes/listing.js");
const reviewRouter = require("./routes/review.js");
const userRouter = require("./routes/user.js");
const bookingRouter = require("./routes/bookings.js");
const adminRouter = require("./routes/admin.js");
const apiRouter = require("./routes/api.js");
const healthRouter = require("./routes/health.js");
const pagesRouter = require("./routes/pages.js");
const listingController = require("./controllers/listings.js");
const paymentController = require("./controllers/payments.js");
const { paymentsEnabled, paymentsMode, paymentsLive } = require("./modules/payments/gateway.js");
const { cachedListings } = require("./modules/cache/listingCache.js");

/**
 * @param {object} options
 * @param {string} options.sessionSecret  secret for signing the session cookie
 * @param {boolean} [options.httpsOnly]   site is served over HTTPS: Secure cookies + upgrade-insecure-requests
 * @param {number}  [options.trustProxy]  number of proxies in front of the app
 * @param {object}  [options.rateLimit]   overrides, e.g. { authMax: 5 }
 * @param {object}  [options.bookings]    { requirePayment, holdMinutes }
 * @param {string}  [options.metricsToken] if set, GET /metrics requires "Authorization: Bearer <token>"
 * @param {object}  [options.business]    { name, email, phone, address } for the contact/policy pages
 */
function createApp({ sessionSecret, httpsOnly = false, trustProxy = 0, rateLimit = {}, bookings = {}, metricsToken, business = {} }) {
  const app = express();

  if (trustProxy) app.set("trust proxy", trustProxy);
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));
  app.engine("ejs", ejsMate);
  app.locals.safeJson = safeJson;
  app.locals.formatPaise = formatPaise;
  app.locals.mapToken = process.env.MAP_TOKEN;
  app.set("bookingOptions", bookings);
  app.locals.business = { name: "TravelByChance", email: "", phone: "", address: "", ...business };

  // Observability first, so every request (even ones rejected early) gets a
  // request ID, an access-log line and a latency measurement.
  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      // Probes and scrapes would be most of the log volume and tell us nothing.
      autoLogging: { ignore: (req) => ["/healthz", "/readyz", "/metrics"].includes(req.url) },
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
      // Deliberately minimal: no headers (cookies, auth) and no bodies (passwords, payment data).
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.raw ? req.raw.originalUrl : req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customProps: (req) => (req.user ? { userId: String(req.user._id) } : {}),
      // originalUrl: inside a router req.url is relative to its mount point ("/").
      customSuccessMessage: (req, res) => `${req.method} ${req.originalUrl} ${res.statusCode}`,
      customErrorMessage: (req, res) => `${req.method} ${req.originalUrl} ${res.statusCode}`,
    }),
  );
  app.use(httpMetrics);

  // Prometheus scrape endpoint. Protect it with METRICS_TOKEN anywhere public:
  // metrics reveal traffic, error rates and internals.
  app.get("/metrics", async (req, res) => {
    if (metricsToken) {
      const expected = Buffer.from(`Bearer ${metricsToken}`);
      const given = Buffer.from(req.get("authorization") || "");
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return res.status(401).end();
    }
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  });

  // Liveness/readiness: no session, no DB writes, cheap for probes.
  app.use(healthRouter);

  // Razorpay webhooks need the RAW body bytes to check the HMAC signature, so
  // this route is registered before express.json() could parse it. It also
  // runs without sessions: Razorpay isn't a logged-in user.
  app.post(
    "/api/v1/webhooks/razorpay",
    express.raw({ type: "application/json", limit: "1mb" }),
    wrapAsync(paymentController.webhook),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // 'unsafe-inline' is still needed: the views use inline <script>
          // blocks and onclick/onmouseover attributes. Moving those to files
          // (and dropping 'unsafe-inline') is listed as a known limitation.
          scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://api.mapbox.com", "https://checkout.razorpay.com", "https://cdn.razorpay.com"],
          scriptSrcAttr: ["'unsafe-inline'"],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
            "https://cdn.jsdelivr.net",
            "https://cdnjs.cloudflare.com",
            "https://api.mapbox.com",
          ],
          fontSrc: ["'self'", "data:", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
          imgSrc: ["'self'", "data:", "blob:", "https:"],
          connectSrc: ["'self'", "https://api.mapbox.com", "https://events.mapbox.com", "https://api.razorpay.com", "https://lumberjack.razorpay.com", "https://cdn.razorpay.com"],
          // Razorpay Checkout opens in an iframe from these origins.
          frameSrc: ["https://api.razorpay.com", "https://checkout.razorpay.com"],
          workerSrc: ["'self'", "blob:"],
          childSrc: ["blob:"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: httpsOnly ? [] : null,
        },
      },
    }),
  );

  app.use(express.urlencoded({ extended: true, limit: "100kb" }));
  app.use(express.json({ limit: "100kb" }));
  app.use(methodOverride("_method"));
  app.use(express.static(path.join(__dirname, "public")));

  // Reuse mongoose's connection pool for sessions instead of opening a second one.
  const store = MongoStore.create({
    client: mongoose.connection.getClient(),
    crypto: { secret: sessionSecret },
    touchAfter: 24 * 3600,
  });
  store.on("error", (err) => {
    reportError(err, { message: "session store error" });
  });
  // Exposed so shutdown code (and tests) can wait for the store's background
  // setup (TTL index creation) before closing the database connection.
  app.set("sessionStore", store);

  app.use(
    session({
      name: "tbc.sid",
      store,
      secret: sessionSecret,
      resave: false,
      // Don't create a session (and a DB write) for every anonymous visitor.
      saveUninitialized: false,
      cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: "lax",
        // Secure cookies are only sent back over HTTPS. Behind a TLS-terminating
        // proxy this also needs TRUST_PROXY so req.secure is true.
        secure: httpsOnly,
      },
    }),
  );
  app.use(flash());

  passport.use(new LocalStrategy(User.authenticate()));
  passport.serializeUser(User.serializeUser());
  passport.deserializeUser(User.deserializeUser());
  app.use(passport.initialize());
  app.use(passport.session());

  app.use((req, res, next) => {
    // Only touch flash when there's something to show. connect-flash's read
    // writes `session.flash = {}` even when empty, which marked EVERY visitor's
    // session as modified: a cookie plus a MongoDB session write on every
    // anonymous page view (found by the Milestone 6 load test).
    const hasFlash = Boolean(req.session.flash && Object.keys(req.session.flash).length);
    res.locals.success = hasFlash ? req.flash("success") : [];
    res.locals.error = hasFlash ? req.flash("error") : [];
    if (hasFlash && Object.keys(req.session.flash).length === 0) delete req.session.flash;
    res.locals.currUser = req.user;
    res.locals.paymentsEnabled = paymentsEnabled();
    res.locals.paymentsMode = paymentsMode(); // "razorpay" | "demo" | null
    res.locals.paymentsLive = paymentsLive(); // real money (Razorpay live keys)
    res.locals.searchQuery = req.query.q || "";
    res.locals.category = req.query.category || "";
    next();
  });

  // Counters live in Redis when REDIS_URL is set, so limits are shared by all
  // instances; otherwise (or while Redis is down) in this process's memory.
  app.use(["/login", "/signup"], createAuthLimiter(rateLimit.authMax));
  app.use("/api/v1/bookings", createBookingLimiter(rateLimit.bookingMax));

  // routeBase() records each mount path for the metrics route label.
  app.use("/listings", routeBase("/listings"), listingRouter);
  app.use("/listings/:id/reviews", routeBase("/listings/:id/reviews"), reviewRouter);
  app.use("/bookings", routeBase("/bookings"), bookingRouter);
  app.use("/admin", routeBase("/admin"), adminRouter);
  app.use("/api/v1", routeBase("/api/v1"), apiRouter);
  app.use("/", routeBase(""), userRouter);
  app.use("/", routeBase(""), pagesRouter);

  // Real-time autocomplete API
  app.get("/api/search-suggestions", wrapAsync(listingController.searchSuggestions));

  // Landing page
  app.get(
    "/",
    wrapAsync(async (req, res) => {
      const featuredListings = await cachedListings("featured", {}, () => listingController.loadListingCards({}, 3));
      res.render("landing.ejs", { featuredListings });
    }),
  );

  app.use((req, res, next) => {
    next(new ExpressError(404, "Page Not Found"));
  });

  app.use((err, req, res, next) => {
    // Only trust status codes from our own errors and Express/body-parser
    // client errors (err.expose). Anything else (e.g. a Razorpay SDK error
    // carrying Razorpay's own 401) must not leak through as OUR status code.
    let statusCode = err instanceof ExpressError ? err.statusCode : err.expose && err.status ? err.status : 500;
    let message = err.message || "Something went wrong!";

    // A malformed id like /listings/abc is a missing page, not a server error.
    if (err instanceof mongoose.Error.CastError) {
      statusCode = 404;
      message = "Page Not Found";
    } else if (err instanceof mongoose.Error.ValidationError) {
      statusCode = 400;
    }

    // Unexpected errors: log everything, tell the client nothing internal.
    // Our own 5xx ExpressErrors (502/503) already carry a safe message.
    if (statusCode >= 500 && !(err instanceof ExpressError)) {
      reportError(err, { method: req.method, route: req.originalUrl.split("?")[0] });
      message = "Something went wrong!";
    }

    const wantsJson =
      req.originalUrl.startsWith("/api/") || req.is("application/json") || req.accepts(["html", "json"]) === "json";
    if (wantsJson) {
      const body = { success: false, message };
      if (err instanceof ExpressError && err.code) body.code = err.code;
      return res.status(statusCode).json(body);
    }
    res.status(statusCode).render("error.ejs", { message });
  });

  return app;
}

module.exports = { createApp };
