const mongoose = require("mongoose");
const { invalidateListings } = require("../modules/cache/listingCache.js");
const { AMENITY_KEYS } = require("../modules/listings/amenities.js");
const { CATEGORY_NAMES } = require("../modules/listings/categories.js");
const Schema = mongoose.Schema;
const Review = require("./review.js");


const listingSchema = new Schema({
  title: {
    type: String,
    required: true,
  },
  description: String,
  image: {
    url: String,
    filename: String,
  },
  price: Number,
  // How many identical units can be booked for the same night (1 for a whole
  // villa, e.g. 6 for a hostel dorm). Listings created before this field
  // existed get the default when loaded.
  units: {
    type: Number,
    default: 1,
    min: 1,
    max: 100,
    validate: { validator: Number.isInteger, message: "units must be a whole number" },
  },
  // Earliest time guests can check in, local time "HH:MM". The arrival-day
  // planner uses it to split the day into "before" and "after" check-in.
  checkInTime: {
    type: String,
    default: "12:00",
    match: [/^([01]\d|2[0-3]):[0-5]\d$/, "check-in time must be HH:MM"],
  },
  // What the host says the stay has (keys from modules/listings/amenities.js).
  amenities: { type: [{ type: String, enum: AMENITY_KEYS }], default: [] },
  location: String,
  country: String,
  reviews:[
    {
      type: Schema.Types.ObjectId,
      ref: "Review",
    },
  ], 
  owner: {
    type: Schema.Types.ObjectId,
    ref : "User"
  },
  geometry:{
    type: {
      type: String, // Don't do `{ location: { type: String } }`
      enum: ['Point'], // 'location.type' must be 'Point'
      required: true
    },
    coordinates: {
      type: [Number],
      required: true
    }
  },
  category: {
    type: String,
    enum: CATEGORY_NAMES,
    required: true,
    default: "Rooms"
  }
});

listingSchema.post("findOneAndDelete", async(listing) => {
  if(listing){
    await Review.deleteMany({_id: {$in: listing.reviews}});
  }
})

// Any change to listings (or to a listing's review list) makes cached listing
// pages out of date. Hooks here, rather than calls in each controller, so no
// write path (admin edits, reviews, seed scripts) can forget to invalidate.
const invalidate = () => invalidateListings();
listingSchema.post("save", invalidate);
listingSchema.post("insertMany", invalidate);
listingSchema.post(["findOneAndUpdate", "findOneAndDelete", "updateOne", "updateMany", "deleteOne", "deleteMany"], invalidate);

const Listing = mongoose.model("Listing", listingSchema);
module.exports = Listing;
