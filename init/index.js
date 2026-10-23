require("../config/env.js"); // loads .env and optional DNS_SERVERS

const mongoose = require("mongoose");
const initData = require("./data.js");
const Listing = require("../models/listing.js");
const User = require("../models/user.js");
const { createGeocoder, placeQuery, SEED_PLACEHOLDER } = require("../modules/listings/geocode.js");

const dbUrl = process.env.ATLASDB_URL || "mongodb://127.0.0.1:27017/travelbychance";


const getCategory = (title = "", description = "") => {
  title = title.toLowerCase();
  description = description.toLowerCase();

  if (title.includes("cabin") || title.includes("mountain") || title.includes("ski") || title.includes("chalet") || description.includes("mountain") || description.includes("slope")) {
    return "Mountains";
  } else if (title.includes("pool") || title.includes("villa") || description.includes("pool") || description.includes("swimming")) {
    return "Amazing Pools";
  } else if (title.includes("loft") || title.includes("penthouse") || title.includes("apartment") || title.includes("city") || title.includes("brownstone") || title.includes("town") || description.includes("urban") || description.includes("city")) {
    return "Iconic Cities";
  } else if (title.includes("beach") || title.includes("ocean") || title.includes("lake") || title.includes("sea") || title.includes("island") || description.includes("beach") || description.includes("ocean")) {
    return "Trending";
  } else if (title.includes("camp") || title.includes("treehouse") || title.includes("forest") || description.includes("camp") || description.includes("glamping")) {
    return "Camping";
  } else if (title.includes("farm") || title.includes("barn") || title.includes("ranch") || title.includes("cow") || description.includes("farm") || description.includes("ranch")) {
    return "Farms";
  } else if (title.includes("dome") || title.includes("igloo") || description.includes("dome")) {
    return "Domes";
  } else if (title.includes("castle") || title.includes("fort") || title.includes("palace") || description.includes("castle") || description.includes("historic")) {
    return "Castles";
  } else if (title.includes("boat") || title.includes("yacht") || title.includes("ship") || description.includes("boat") || description.includes("yacht")) {
    return "Boats";
  } else if (title.includes("arctic") || title.includes("snow") || title.includes("ice") || description.includes("arctic") || description.includes("polar")) {
    return "Arctic";
  }
  return "Rooms";
};

const initDB = async () => {
  await Listing.deleteMany({});
  
  let defaultOwner = await User.findOne({ username: "demo" });
  if (!defaultOwner) {
    defaultOwner = await User.findOne({});
  }
  
  if (!defaultOwner) {
    console.error("No users found in database! Please register a user first before running seeding.");
    return;
  }

  // Real map location for each listing. (This used to put every listing in
  // Delhi.) Without a Mapbox token, or if a lookup fails, the placeholder is
  // kept and `npm run fix:locations` can fill it in later.
  const geocode = process.env.MAP_TOKEN ? createGeocoder() : null;
  if (!geocode) console.log("MAP_TOKEN not set: listings get a placeholder location");
  const listings = [];
  for (const obj of initData.data) {
    let geometry = null;
    if (geocode) {
      try {
        geometry = await geocode(placeQuery(obj), { country: obj.country });
      } catch (err) {
        console.log(`location lookup failed for "${obj.title}": ${err.message}`);
      }
    }
    listings.push({
      ...obj,
      owner: defaultOwner._id,
      category: getCategory(obj.title, obj.description),
      geometry: geometry || { type: "Point", coordinates: SEED_PLACEHOLDER },
    });
  }
  await Listing.insertMany(listings);
  const located = listings.filter((l) => l.geometry.coordinates !== SEED_PLACEHOLDER).length;
  console.log(`data was initialized with owner: ${defaultOwner.username} (${located}/${listings.length} listings located)`);
};

mongoose
  .connect(dbUrl)
  .then(() => {
    console.log("connected to database");
    return initDB();
  })
  .catch((err) => {
    console.log(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
