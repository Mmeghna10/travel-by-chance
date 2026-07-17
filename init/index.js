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
const initData = require("./data.js");
const Listing = require("../models/listing.js");
const User = require("../models/user.js");

const dbUrl = process.env.ATLASDB_URL || "mongodb://127.0.0.1:27017/travelbychance";

main()
  .then(() => {
    console.log("connected to database");
  })
  .catch((err) => {
    console.log(err);
  });

async function main() {
  await mongoose.connect(dbUrl);
}

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

  initData.data = initData.data.map((obj) => ({
    ...obj,
    owner: defaultOwner._id,
    category: getCategory(obj.title, obj.description),
    geometry: {
      type: "Point",
      coordinates: [77.209, 28.613] // default coordinates
    }
  }));
  await Listing.insertMany(initData.data);
  console.log("data was initialized with owner:", defaultOwner.username);
};

initDB();
