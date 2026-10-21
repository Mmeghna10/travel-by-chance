const { listingSchema , reviewSchema } = require("./schema.js");
const ExpressError = require("./utils/ExpressError.js");
const Listing = require("./models/listing")
const Review = require("./models/review.js")

module.exports.isLoggedIn = (req, res, next) => {
     if(!req.isAuthenticated()){
        if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1) || req.originalUrl.startsWith('/bookings')) {
          return res.status(401).json({ success: false, message: "You must be logged in to reserve stays!" });
        }
        req.session.redirectUrl = req.originalUrl;
        req.flash("error", "You must be logged in!");
        return res.redirect("/login");
   }
   next();
}

module.exports.saveRedirectUrl = (req,res,next) => {
  if(req.session.redirectUrl ){
    res.locals.redirectUrl= req.session.redirectUrl;
}
next();
};

module.exports.isOwner = async(req,res,next) => {
   let { id } = req.params;
   let listing = await Listing.findById(id);
  if (!listing) {
    throw new ExpressError(404, "Listing not found");
  }
  if(!listing.owner || !listing.owner.equals(res.locals.currUser._id)){
    req.flash("error", "You're not the owner of this listing");
  return res.redirect(`/listings/${id}`);
  }
  next();
}

module.exports.validateListing = (req, res, next) => {
  let { error } = listingSchema.validate(req.body);
  if (error) {
    let errMsg = error.details.map((el) => el.message).join(",")
    throw new ExpressError(400, errMsg);
  } else {
    next();
  }
}

module.exports.validateReview = (req, res, next) => {
  let { error } = reviewSchema.validate(req.body);
  if (error) {
    let errMsg = error.details.map((el) => el.message).join(",")
    throw new ExpressError(400, errMsg);
  } else {
    next();
  }
}

module.exports.isReviewAuthor = async(req,res,next) => {
   let { id , reviewId } = req.params;
   let review = await Review.findById(reviewId);
  if (!review) {
    throw new ExpressError(404, "Review not found");
  }
  if(!review.author || !review.author.equals(res.locals.currUser._id)){
    req.flash("error", "You're not the author of this review");
  return res.redirect(`/listings/${id}`);
  }
  next();
}

module.exports.isAdmin = (req, res, next) => {
  if (!req.isAuthenticated() || req.user.role !== "admin") {
    req.flash("error", "Access denied. Admin privileges required!");
    return res.redirect("/listings");
  }
  next();
}
