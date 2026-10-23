const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync.js");
const { isLoggedIn, isOwner, validateListing, isAdmin } = require("../middleware.js");

const listingController = require("../controllers/listings.js");

const { uploadListingImage } = require("../cloudConfig.js");
const upload = uploadListingImage();




router
  .route("/")
  .get(wrapAsync(listingController.index))
  .post(
    isLoggedIn,
    isAdmin,
    upload,
    validateListing,
    wrapAsync(listingController.createListing),
  )

  //New Route
router.get("/new", isLoggedIn, isAdmin, listingController.renderNewForm);

router
.route("/:id")
.get(wrapAsync(listingController.showListing))
.put(
  isLoggedIn,
  isOwner,
  // The edit form is multipart (it can include a new image), so multer must
  // parse it before validation; without this req.body was empty.
  upload,
  validateListing,
  wrapAsync(listingController.updateListing),
)
.delete(
  isLoggedIn,
  isOwner,
  wrapAsync(listingController.destroyListing),
);





//Edit Route
router.get(
  "/:id/edit",
  isLoggedIn,
  isOwner,
  wrapAsync(listingController.renderEditForm),
);




module.exports = router;
