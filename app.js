const dns = require('dns');
try {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {
  console.warn("Could not set DNS servers:", e);
}

if(process.env.NODE_ENV != "production"){
require('dotenv').config();
}



const express = require("express");
const app = express();
const mongoose = require("mongoose");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");
const ExpressError = require("./utils/ExpressError.js");
const  session = require("express-session");
const MongoStore = require("connect-mongo");
const flash = require("connect-flash");
const passport = require("passport");
const LocalStrategy = require("passport-local");
const User = require("./models/user.js");
const PORT = process.env.PORT || 8080;

const listingRouter = require("./routes/listing.js");
const reviewRouter = require("./routes/review.js");
const userRouter = require("./routes/user.js");
const bookingRouter = require("./routes/bookings.js");
const adminRouter = require("./routes/admin.js");

// const MONGO_URL = "mongodb://127.0.0.1:27017/travelbychance";
const dbUrl = process.env.ATLASDB_URL;


main()
  .then(() => {
    console.log("connected to database");
  })
  .catch((err) => {
    console.log(err);
  });

async function main() {
  await mongoose.connect(dbUrl);
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));
app.engine("ejs", ejsMate);
app.use(express.static(path.join(__dirname, "/public")));


const store = MongoStore.create({
  mongoUrl: dbUrl,
  crypto: {
    secret: process.env.SECRET,
  },
  touchAfter: 24 * 3600,
});

store.on("error", () => {
  console.log("ERROR in MONGO SESSION STORE", err);
});


const sessionOptions = {
  store,
  secret: process.env.SECRET,
  resave: false,
  saveUninitialized: true,
  cookie:{
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
  },
};

// Root Route (moved to bottom section)




app.use(session(sessionOptions));
app.use(flash());

// Configure passport BEFORE passport.session() mounts so deserializeUser works on all requests
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

// app.get("/demouser", async(req, res) => {
//   let fakeUser = new User({
//     email: "student@gmail.com",
//     username: "delta-student"
//   });

//   let registeredUser = await User.register(fakeUser, "helloworld");
//   res.send(registeredUser);
// })

// express.json() is already added above (before session/routes)
app.use("/listings", listingRouter);
app.use("/listings/:id/reviews", reviewRouter);
app.use("/bookings", bookingRouter);
app.use("/admin", adminRouter);
app.use("/", userRouter);

// Real-time autocomplete API
const listingController = require("./controllers/listings.js");
const wrapAsync = require("./utils/wrapAsync.js");
app.get("/api/search-suggestions", wrapAsync(listingController.searchSuggestions));

// Root Route - Landing Page
const Listing = require("./models/listing.js");
app.get("/", wrapAsync(async (req, res) => {
  const featuredListings = await Listing.find({}).limit(3).populate('reviews');
  const listingsWithRatings = featuredListings.map(listing => {
    const ratings = listing.reviews.map(r => r.rating).filter(r => typeof r === 'number');
    const avg = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : 0;
    listing.averageRating = avg;
    return listing;
  });
  res.render("landing.ejs", { featuredListings: listingsWithRatings });
}));


// Handle 404 (route not found) errors
app.use((req, res, next) => {
  next(new ExpressError(404, "Page Not Found"));
});

app.use((err, req, res, next) => {
  let { statusCode = 500, message = "Something went  wrong!" } = err;
  // res.status(statusCode).send(message);
  res.status(statusCode).render("error.ejs", { message });
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});