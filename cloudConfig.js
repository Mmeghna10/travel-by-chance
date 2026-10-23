const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const ExpressError = require("./utils/ExpressError.js");
const { CloudinaryStorage } = require("./modules/uploads/cloudinaryStorage.js");

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_API_KEY,
  api_secret: process.env.CLOUD_API_SECRET,
});

const storage = new CloudinaryStorage({ uploader: cloudinary.uploader, folder: "travelByChance_DEV" });

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);

/**
 * Multer middleware for one listing image: PNG/JPEG only, at most 5 MB.
 * Rejected files are never sent to Cloudinary. Errors become a 400 with a
 * readable message instead of a generic 500.
 */
function uploadListingImage(storageEngine = storage) {
  const upload = multer({
    storage: storageEngine,
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      if (IMAGE_TYPES.has(file.mimetype)) return cb(null, true);
      cb(new ExpressError(400, "Please upload a PNG or JPEG image."));
    },
  }).single("listing[image]");

  return (req, res, next) =>
    upload(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        const message = err.code === "LIMIT_FILE_SIZE" ? "Images must be 5 MB or smaller." : "That upload couldn't be processed.";
        return next(new ExpressError(400, message));
      }
      // Cloudinary refused the file (e.g. not really an image): the user's
      // problem, not a server error.
      if (err.http_code >= 400 && err.http_code < 500) {
        return next(new ExpressError(400, "That image couldn't be uploaded. Please use a PNG or JPEG."));
      }
      next(err);
    });
}

module.exports = {
  cloudinary,
  storage,
  uploadListingImage,
  MAX_IMAGE_BYTES,
};
