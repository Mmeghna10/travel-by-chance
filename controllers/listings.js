
const Listing = require("../models/listing");
const Review = require("../models/review.js");
const mbxGeocoding = require('@mapbox/mapbox-sdk/services/geocoding');
const mapToken = process.env.MAP_TOKEN;
const geocodingClient = mbxGeocoding({ accessToken: mapToken });


module.exports.index = async (req, res) => {
  let { q, category } = req.query;
  let filter = {};

  if (q && q.trim()) {
    const qTrim = q.trim();
    filter.$or = [
      { title: { $regex: qTrim, $options: "i" } },
      { location: { $regex: qTrim, $options: "i" } },
      { country: { $regex: qTrim, $options: "i" } },
      { description: { $regex: qTrim, $options: "i" } },
    ];
  }

  if (category) {
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
    .populate({
      path: "reviews",
      populate: { path: "author" },
    })
    .populate("owner");

  if (!listing) {
    req.flash("error", "Listing you requested for does not exist!");
    return res.redirect("/listings");
  }

  const ratings = listing.reviews.map(r => r.rating).filter(r => typeof r === 'number');
  listing.averageRating = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : 0;

  return res.render("listings/show.ejs", { listing });
};


module.exports.createListing = async (req, res, next) => {
  let geoResponse = await geocodingClient
    .forwardGeocode({ query: req.body.listing.location, limit: 1 })
    .send();

  if (!req.file) {
    req.flash("error", "Please upload a valid image file.");
    return res.redirect("/listings/new");
  }

  let url = req.file.path;
  let filename = req.file.filename;

  const newListing = new Listing(req.body.listing);
  newListing.owner = req.user._id;
  newListing.image = { url, filename };

  // Use geocoded geometry or fallback to [0,0] if location not found
  const features = geoResponse.body.features;
  if (features && features.length > 0) {
    newListing.geometry = features[0].geometry;
  } else {
    newListing.geometry = { type: "Point", coordinates: [0, 0] };
  }

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
  let listing = await Listing.findByIdAndUpdate(id, { ...req.body.listing });

  if (typeof req.file !== "undefined") {
    let url = req.file.path;
    let filename = req.file.filename;
    listing.image = { url, filename };
    await listing.save();
  }
  req.flash("success", "✅ Listing updated!");
  res.redirect(`/listings/${id}`);
};


module.exports.destroyListing = async (req, res) => {
  let { id } = req.params;
  await Listing.findByIdAndDelete(id);
  req.flash("success", "🗑️ Listing deleted.");
  res.redirect("/listings");
};


// Autocomplete search suggestions API
module.exports.searchSuggestions = async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json([]);

  const suggestions = await Listing.find({
    $or: [
      { title: { $regex: q.trim(), $options: "i" } },
      { location: { $regex: q.trim(), $options: "i" } },
      { country: { $regex: q.trim(), $options: "i" } },
    ],
  })
    .select("title location country _id")
    .limit(8);

  res.json(suggestions);
};