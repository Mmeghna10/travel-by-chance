
const Listing = require("../models/listing");
const Review = require("../models/review.js");
const escapeRegex = require("../utils/escapeRegex.js");
const Booking = require("../models/booking.js");
const InventoryNight = require("../models/inventoryNight.js");
const { quote } = require("../modules/bookings/pricing.js");
const { cachedListings } = require("../modules/cache/listingCache.js");
const { createGeocoder, placeQuery, NOT_FOUND } = require("../modules/listings/geocode.js");
let lookUpPlace = createGeocoder();
/** For tests: replace the Mapbox lookup. */
module.exports.setPlaceLookup = (fn) => {
  lookUpPlace = fn || createGeocoder();
};

const MAX_QUERY_LENGTH = 100;

// The map pin: the street address if the host gave one and it's found,
// else the city. Returns { geometry, precision }.
async function geocode({ address, location, country }) {
  if (address && address.trim()) {
    const exact = await lookUpPlace(`${address.trim()}, ${location}`, { country });
    if (exact) return { geometry: exact, precision: "address" };
  }
  // Fallback to [0,0] if location not found (npm run fix:locations retries these)
  const city = await lookUpPlace(placeQuery({ location, country }), { country });
  return { geometry: city || { type: "Point", coordinates: NOT_FOUND }, precision: "city" };
}


function averageRating(reviews) {
  const ratings = reviews.map((r) => r.rating).filter((r) => typeof r === "number");
  return ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : 0;
}

// Listing cards for the browse and landing pages, as plain JSON so they can
// be cached (modules/cache/listingCache.js). Only the fields the cards show.
async function loadListingCards(filter, limit = 0) {
  const listings = await Listing.find(filter)
    .select("title image price location country category reviews")
    .populate("reviews", "rating")
    .limit(limit)
    .lean();
  // Round-trip through JSON so a cache miss renders exactly like a cache hit.
  return JSON.parse(JSON.stringify(listings.map((l) => ({ ...l, averageRating: averageRating(l.reviews) }))));
}
module.exports.loadListingCards = loadListingCards;

// The numbers on the home page, counted from the database.
async function loadSiteStats() {
  const [stays, cities, ratings] = await Promise.all([
    Listing.countDocuments(),
    Listing.distinct("location"),
    Review.aggregate([{ $match: { rating: { $type: "number" } } }, { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } }]),
  ]);
  const r = ratings[0];
  return { stays, cities: cities.length, reviews: r ? r.count : 0, avgRating: r ? Number(r.avg.toFixed(1)) : null };
}
module.exports.loadSiteStats = loadSiteStats;

module.exports.index = async (req, res) => {
  let { q, category } = req.query;
  let filter = {};
  const search = typeof q === "string" ? q.trim().slice(0, MAX_QUERY_LENGTH) : "";

  if (search) {
    const pattern = escapeRegex(search);
    filter.$or = [
      { title: { $regex: pattern, $options: "i" } },
      { location: { $regex: pattern, $options: "i" } },
      { country: { $regex: pattern, $options: "i" } },
      { description: { $regex: pattern, $options: "i" } },
    ];
  }

  // Must be a plain string: ?category[$ne]=x would otherwise become a query operator.
  if (typeof category === "string" && category) {
    filter.category = category;
  }

  const allListings = await cachedListings("browse", { search, category: filter.category || "" }, () =>
    loadListingCards(filter),
  );

  if (allListings.length === 0 && (q || category)) {
    req.flash("error", `No stays found${q ? ` for "${q}"` : ""}${category ? ` in ${category}` : ""}. Try a different search!`);
    return res.redirect("/listings");
  }

  res.render("listings/index.ejs", {
    allListings,
    searchQuery: q || "",
    category: category || "",
  });
  return;

};


module.exports.renderNewForm = (req, res) => {
  res.render("listings/new.ejs");
};


module.exports.showListing = async (req, res) => {
  let { id } = req.params;
  const listing = await Listing.findById(id)
    // Only usernames: the page must not expose other users' emails.
    .populate({
      path: "reviews",
      populate: { path: "author", select: "username" },
    })
    .populate("owner", "username");

  if (!listing) {
    req.flash("error", "Listing you requested for does not exist!");
    return res.redirect("/listings");
  }

  const ratings = listing.reviews.map(r => r.rating).filter(r => typeof r === 'number');
  listing.averageRating = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : 0;

  // Server-computed 1-night price for the initial render; the page then asks
  // the quote API whenever dates change, so it never computes prices itself.
  return res.render("listings/show.ejs", { listing, oneNightQuote: quote(listing.price || 0, 1) });
};


module.exports.createListing = async (req, res, next) => {
  if (!req.file) {
    req.flash("error", "Please upload a valid image file.");
    return res.redirect("/listings/new");
  }

  let url = req.file.path;
  let filename = req.file.filename;

  const newListing = new Listing(req.body.listing);
  newListing.owner = req.user._id;
  newListing.image = { url, filename };

  const pin = await geocode(req.body.listing);
  newListing.geometry = pin.geometry;
  newListing.locationPrecision = pin.precision;
  if (req.body.listing.address && pin.precision === "city") {
    req.flash("error", "We couldn't find that street address, so the map shows the city for now. You can correct it by editing the listing.");
  }

  await newListing.save();
  req.flash("success", "🎉 New listing created successfully!");
  res.redirect("/listings");
};


module.exports.renderEditForm = async (req, res) => {
  let { id } = req.params;
  const listing = await Listing.findById(id);
  if (!listing) {
    req.flash("error", "Listing you requested for does not exist!");
    return res.redirect("/listings");
  }
  let originalImageUrl = listing.image.url;
  originalImageUrl = originalImageUrl.replace("/upload", "/upload/w_250");
  return res.render("listings/edit.ejs", { listing, originalImageUrl });
};


module.exports.updateListing = async (req, res) => {
  let { id } = req.params;
  const { image, ...fields } = req.body.listing;
  const listing = await Listing.findById(id);

  const locationChanged =
    fields.location !== listing.location || fields.country !== listing.country || (fields.address || "") !== (listing.address || "");
  listing.set(fields);
  // Unticked checkboxes aren't sent at all, so "none ticked" means none.
  listing.amenities = [].concat(fields.amenities || []);
  if (locationChanged) {
    const pin = await geocode(fields);
    listing.geometry = pin.geometry;
    listing.locationPrecision = pin.precision;
    if (fields.address && pin.precision === "city") {
      req.flash("error", "We couldn't find that street address, so the map shows the city for now.");
    }
  }
  if (req.file) {
    listing.image = { url: req.file.path, filename: req.file.filename };
  }
  await listing.save();
  req.flash("success", "✅ Listing updated!");
  res.redirect(`/listings/${id}`);
};


module.exports.destroyListing = async (req, res) => {
  let { id } = req.params;
  // Deleting a listing would strand guests with upcoming stays. Bookings with
  // no status are pre-Milestone-2 bookings and count as active.
  const hasUpcomingStays = await Booking.exists({
    listing: id,
    $or: [{ status: { $in: Booking.ACTIVE_STATUSES } }, { status: { $exists: false } }],
    checkOut: { $gt: new Date() },
  });
  if (hasUpcomingStays) {
    req.flash("error", "This listing has upcoming bookings and can't be deleted yet.");
    return res.redirect(`/listings/${id}`);
  }
  await Listing.findByIdAndDelete(id);
  await InventoryNight.deleteMany({ listing: id });
  req.flash("success", "🗑️ Listing deleted.");
  res.redirect("/listings");
};


// Autocomplete search suggestions API
module.exports.searchSuggestions = async (req, res) => {
  const { q } = req.query;
  if (typeof q !== "string" || q.trim().length < 2) return res.json([]);

  const search = q.trim().slice(0, MAX_QUERY_LENGTH);
  // Fired on every keystroke in the navbar, so it's the hottest read: cache it.
  const suggestions = await cachedListings("suggest", { search: search.toLowerCase() }, async () => {
    const pattern = escapeRegex(search);
    const found = await Listing.find({
      $or: [
        { title: { $regex: pattern, $options: "i" } },
        { location: { $regex: pattern, $options: "i" } },
        { country: { $regex: pattern, $options: "i" } },
      ],
    })
      .select("title location country _id")
      .limit(8)
      .lean();
    return JSON.parse(JSON.stringify(found));
  });

  res.json(suggestions);
};