const dns = require('dns');
try {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {
  console.warn("Could not set DNS servers:", e);
}

if (process.env.NODE_ENV != "production") {
  require('dotenv').config();
}

const mongoose = require("mongoose");
const User = require("../models/user.js");
const Listing = require("../models/listing.js");

const dbUrl = process.env.ATLASDB_URL;

async function run() {
  await mongoose.connect(dbUrl);
  const users = await User.find({});
  const listings = await Listing.find({});
  console.log("Users:", users.map(u => ({ id: u._id, username: u.username })));
  console.log("Number of listings:", listings.length);
  if (listings.length > 0) {
    console.log("Sample Listing Owner:", listings[0].owner);
  }
  mongoose.connection.close();
}

run();
