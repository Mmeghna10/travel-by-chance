// Listing image uploads: the Cloudinary storage engine (with a stand-in for
// Cloudinary's uploader) and the type/size limits in front of it.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const express = require("express");
const Listing = require("../models/listing.js");
const { CloudinaryStorage } = require("../modules/uploads/cloudinaryStorage.js");
const { uploadListingImage, MAX_IMAGE_BYTES } = require("../cloudConfig.js");
const h = require("./helpers.js");

// Behaves like cloudinary.v2.uploader: upload_stream(options, callback)
// returns a writable stream; the callback gets the result when it ends.
function fakeUploader({ fail } = {}) {
  const calls = { uploads: [], destroyed: [] };
  return {
    calls,
    upload_stream(options, callback) {
      const chunks = [];
      return new Writable({
        write(chunk, enc, next) {
          chunks.push(chunk);
          next();
        },
        final(next) {
          const bytes = Buffer.concat(chunks);
          calls.uploads.push({ options, bytes });
          if (fail) callback(fail);
          else callback(null, { secure_url: "https://res.cloudinary.com/demo/image/upload/v1/tbc/abc.png", public_id: "tbc/abc", bytes: bytes.length });
          next();
        },
      });
    },
    destroy(publicId, options, callback) {
      calls.destroyed.push(publicId);
      callback(null, { result: "ok" });
    },
  };
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // PNG signature + IHDR start

// A minimal app around just the upload middleware.
function uploadApp(uploader) {
  const app = express();
  app.post("/upload", uploadListingImage(new CloudinaryStorage({ uploader, folder: "tbc" })), (req, res) => {
    res.json({ path: req.file && req.file.path, filename: req.file && req.file.filename });
  });
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ message: err.message }));
  return app;
}

test("a PNG is streamed to Cloudinary; the route sees its URL and public id", async () => {
  const uploader = fakeUploader();
  const res = await h.request(uploadApp(uploader)).post("/upload").attach("listing[image]", PNG, { filename: "a.png", contentType: "image/png" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { path: "https://res.cloudinary.com/demo/image/upload/v1/tbc/abc.png", filename: "tbc/abc" });
  assert.deepEqual(uploader.calls.uploads[0].bytes, PNG, "bytes arrive intact");
  assert.equal(uploader.calls.uploads[0].options.folder, "tbc");
  assert.deepEqual(uploader.calls.uploads[0].options.allowed_formats, ["png", "jpg", "jpeg"]);
});

test("non-images are rejected before anything is sent to Cloudinary", async () => {
  const uploader = fakeUploader();
  const res = await h.request(uploadApp(uploader)).post("/upload").attach("listing[image]", Buffer.from("hello"), { filename: "notes.txt", contentType: "text/plain" });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /PNG or JPEG/);
  assert.equal(uploader.calls.uploads.length, 0);
});

test("images over 5 MB are rejected with a clear message", async () => {
  const uploader = fakeUploader();
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  const res = await h.request(uploadApp(uploader)).post("/upload").attach("listing[image]", big, { filename: "big.png", contentType: "image/png" });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /5 MB/);
});

test("Cloudinary refusing a file is a 400, not a server error", async () => {
  const uploader = fakeUploader({ fail: Object.assign(new Error("Invalid image file"), { http_code: 400 }) });
  const res = await h.request(uploadApp(uploader)).post("/upload").attach("listing[image]", PNG, { filename: "fake.png", contentType: "image/png" });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /couldn't be uploaded/);
});

test("_removeFile deletes the uploaded image from Cloudinary", async () => {
  const uploader = fakeUploader();
  const storage = new CloudinaryStorage({ uploader, folder: "tbc" });
  await new Promise((resolve, reject) => storage._removeFile({}, { filename: "tbc/abc" }, (err) => (err ? reject(err) : resolve())));
  assert.deepEqual(uploader.calls.destroyed, ["tbc/abc"]);
});

// The real route, end to end: a host uploading a text file gets a 400 and no listing.
let app;
before(async () => {
  await h.startDb();
  app = h.buildApp();
});
after(h.stopDb);
beforeEach(h.resetDb);

test("POST /listings with a non-image file creates nothing", async () => {
  await h.createUser("host", "admin");
  const agent = await h.loginAgent(app, "host");
  const res = await agent
    .post("/listings")
    .field("listing[title]", "Bad Upload")
    .field("listing[description]", "x")
    .field("listing[price]", "1000")
    .field("listing[location]", "Pune")
    .field("listing[country]", "India")
    .attach("listing[image]", Buffer.from("not an image"), { filename: "x.txt", contentType: "text/plain" });
  assert.equal(res.status, 400);
  assert.equal(await Listing.countDocuments(), 0);
});
