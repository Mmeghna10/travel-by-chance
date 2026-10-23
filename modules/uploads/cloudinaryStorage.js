// Multer storage engine that streams an uploaded image straight to Cloudinary
// (official SDK v2). Replaces multer-storage-cloudinary, which pinned
// cloudinary@1, a version with a known high-severity advisory.
//
// The file never touches local disk. On success, multer sees req.file.path
// (the image URL) and req.file.filename (Cloudinary's public_id), the same
// fields the listing controller already used.
const ALLOWED_FORMATS = ["png", "jpg", "jpeg"];

class CloudinaryStorage {
  /**
   * @param {object} options
   * @param {object} options.uploader  cloudinary.v2.uploader (or a test double)
   * @param {string} options.folder    Cloudinary folder for uploads
   */
  constructor({ uploader, folder }) {
    this.uploader = uploader;
    this.folder = folder;
  }

  _handleFile(req, file, cb) {
    let done = false;
    const finish = (err, info) => {
      if (done) return;
      done = true;
      cb(err, info);
    };
    const upload = this.uploader.upload_stream(
      // Cloudinary re-checks the format itself, so a renamed .exe is rejected
      // even if it slipped past the MIME-type filter.
      { folder: this.folder, resource_type: "image", allowed_formats: ALLOWED_FORMATS },
      (err, result) => {
        if (err) return finish(err);
        finish(null, { path: result.secure_url, filename: result.public_id, size: result.bytes });
      },
    );
    file.stream.on("error", finish);
    file.stream.pipe(upload);
  }

  // Called by multer when a later step fails, so the uploaded image isn't orphaned.
  _removeFile(req, file, cb) {
    this.uploader.destroy(file.filename, { resource_type: "image" }, (err) => cb(err || null));
  }
}

module.exports = { CloudinaryStorage, ALLOWED_FORMATS };
