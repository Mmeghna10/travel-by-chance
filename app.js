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

const ExpressError = require("./utils/ExpressError.js");
const wrapAsync = require("./utils/wrapAsync.js");
const safeJson = require("./utils/safeJson.js");
const { createAuthLimiter, createBookingLimiter } = require("./middleware/rateLimits.js");
const User = require("./models/user.js");
const Listing = require("./models/listing.js");

const listingRouter = require("./routes/listing.js");
const reviewRouter = require("./routes/review.js");
const userRouter = require("./routes/user.js");
const bookingRouter = require("./routes/bookings.js");
const adminRouter = require("./routes/admin.js");
const healthRouter = require("./routes/health.js");
const listingController = require("./controllers/listings.js");

/**
 * @param {object} options
 * @param {string} options.sessionSecret  secret for signing the session cookie
 * @param {boolean} [options.isProduction]
 * @param {number}  [options.trustProxy]  number of proxies in front of the app
 * @param {object}  [options.rateLimit]   overrides, e.g. { authMax: 5 }
 */
function createApp({ sessionSecret, isProduction = false, trustProxy = 0, rateLimit = {} }) {
  const app = express();

  if (trustProxy) app.set("trust proxy", trustProxy);
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));
  app.engine("ejs", ejsMate);
  app.locals.safeJson = safeJson;
  app.locals.mapToken = process.env.MAP_TOKEN;

  // Liveness/readiness first: no session, no DB writes, cheap for probes.
  app.use(healthRouter);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // 'unsafe-inline' is still needed: the views use inline <script>
          // blocks and onclick/onmouseover attributes. Moving those to files
          // (and dropping 'unsafe-inline') is listed as a known limitation.
          scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://api.mapbox.com"],
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
          connectSrc: ["'self'", "https://api.mapbox.com", "https://events.mapbox.com"],
          workerSrc: ["'self'", "blob:"],
          childSrc: ["blob:"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: isProduction ? [] : null,
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
    console.error("Session store error:", err);
  });

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
        secure: isProduction,
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
    res.locals.success = req.flash("success");
    res.locals.error = req.flash("error");
    res.locals.currUser = req.user;
    res.locals.searchQuery = req.query.q || "";
    res.locals.category = req.query.category || "";
    next();
  });

  // Limiters are created per app so each instance (and each test) has its own
  // counters. The default store is in-memory, i.e. per process; with several
  // instances behind a load balancer this moves to a shared (Redis) store.
  app.use(["/login", "/signup"], createAuthLimiter(rateLimit.authMax));
  app.use("/bookings", createBookingLimiter(rateLimit.bookingMax));

  app.use("/listings", listingRouter);
  app.use("/listings/:id/reviews", reviewRouter);
  app.use("/bookings", bookingRouter);
  app.use("/admin", adminRouter);
  app.use("/", userRouter);

  // Real-time autocomplete API
  app.get("/api/search-suggestions", wrapAsync(listingController.searchSuggestions));

  // Landing page
  app.get(
    "/",
    wrapAsync(async (req, res) => {
      const featuredListings = await Listing.find({}).limit(3).populate("reviews");
      const listingsWithRatings = featuredListings.map((listing) => {
        const ratings = listing.reviews.map((r) => r.rating).filter((r) => typeof r === "number");
        const avg = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : 0;
        listing.averageRating = avg;
        return listing;
      });
      res.render("landing.ejs", { featuredListings: listingsWithRatings });
    }),
  );

  app.use((req, res, next) => {
    next(new ExpressError(404, "Page Not Found"));
  });

  app.use((err, req, res, next) => {
    let { statusCode = 500, message = "Something went wrong!" } = err;

    // A malformed id like /listings/abc is a missing page, not a server error.
    if (err instanceof mongoose.Error.CastError) {
      statusCode = 404;
      message = "Page Not Found";
    } else if (err instanceof mongoose.Error.ValidationError) {
      statusCode = 400;
    }

    if (statusCode >= 500) {
      console.error(err);
      message = "Something went wrong!"; // don't leak internals to the client
    }

    const wantsJson =
      req.originalUrl.startsWith("/api/") || req.is("application/json") || req.accepts(["html", "json"]) === "json";
    if (wantsJson) {
      return res.status(statusCode).json({ success: false, message });
    }
    res.status(statusCode).render("error.ejs", { message });
  });

  return app;
}

module.exports = { createApp };
