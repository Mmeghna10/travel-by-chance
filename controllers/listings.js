
const Listing = require("../models/listing");
const Review = require("../models/review.js");
const escapeRegex = require("../utils/escapeRegex.js");
const Booking = require("../models/booking.js");
const InventoryNight = require("../models/inventoryNight.js");
const { quote } = require("../modules/bookings/pricing.js");
const mbxGeocoding = require('@mapbox/mapbox-sdk/services/geocoding');
const mapToken = process.env.MAP_TOKEN;
const geocodingClient = mbxGeocoding({ accessToken: mapToken });

const MAX_QUERY_LENGTH = 100;

async function geocode(location) {
  const geoResponse = await geocodingClient.forwardGeocode({ query: location, limit: 1 }).send();
  const features = geoResponse.body.features;
  // Fallback to [0,0] if location not found
  return features && features.length > 0 ? features[0].geometry : { type: "Point", coordinates: [0, 0] };
}


module.exports.index = async (req, res) => {
  let { q, category } = req.query;
  let filter = {};

  if (typeof q === "string" && q.trim()) {
    const pattern = escapeRegex(q.trim().slice(0, MAX_QUERY_LENGTH));
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

  const allListings = await Listing.find(filter).populate('reviews');

  if (allListings.length === 0 && (q || category)) {
    req.flash("error", `No stays found${q ? ` for "${q}"` : ""}${category ? ` in ${category}` : ""}. Try a different search!`);
    return res.redirect("/listings");
  }

  // Compute average rating for each listing
  const listingsWithRatings = allListings.map(listing => {
    const ratings = listing.reviews.map(r => r.rating).filter(r => typeof r === 'number');
    const avg = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : 0;
    listing.averageRating = avg;
    return listing;
  });
  res.render("listings/index.ejs", {
    allListings: listingsWithRatings,
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

  newListing.geometry = await geocode(`${req.body.listing.location}, ${req.body.listing.country}`);

  let savedListing = await newListing.save();
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

  const locationChanged = fields.location !== listing.location || fields.country !== listing.country;
  listing.set(fields);
  if (locationChanged) {
    listing.geometry = await geocode(`${fields.location}, ${fields.country}`);
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
    status: { $nin: ["EXPIRED", "CANCELLED", "REFUNDED"] },
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

  const pattern = escapeRegex(q.trim().slice(0, MAX_QUERY_LENGTH));
  const suggestions = await Listing.find({
    $or: [
      { title: { $regex: pattern, $options: "i" } },
      { location: { $regex: pattern, $options: "i" } },
      { country: { $regex: pattern, $options: "i" } },
    ],
  })
    .select("title location country _id")
    .limit(8);

  res.json(suggestions);
};