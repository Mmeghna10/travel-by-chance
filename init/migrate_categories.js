require("../config/env.js"); // loads .env and optional DNS_SERVERS

const mongoose = require("mongoose");
const Listing = require("../models/listing.js");

const dbUrl = process.env.ATLASDB_URL;

async function main() {
  await mongoose.connect(dbUrl);
}

main()
  .then(async () => {
    console.log("connected to database for migration");
    await migrateCategories();
    mongoose.connection.close();
  })
  .catch((err) => {
    console.log("database connection error:", err);
  });

async function migrateCategories() {
  const listings = await Listing.find({});
  console.log(`Found ${listings.length} listings to migrate.`);

  let updatedCount = 0;
  for (let listing of listings) {
    const title = listing.title ? listing.title.toLowerCase() : "";
    const description = listing.description ? listing.description.toLowerCase() : "";
    
    let category = "Rooms";

    if (title.includes("cabin") || title.includes("mountain") || title.includes("ski") || title.includes("chalet") || description.includes("mountain") || description.includes("slope")) {
      category = "Mountains";
    } else if (title.includes("pool") || title.includes("villa") || description.includes("pool") || description.includes("swimming")) {
      category = "Amazing Pools";
    } else if (title.includes("loft") || title.includes("penthouse") || title.includes("apartment") || title.includes("city") || title.includes("brownstone") || title.includes("town") || description.includes("urban") || description.includes("city")) {
      category = "Iconic Cities";
    } else if (title.includes("beach") || title.includes("ocean") || title.includes("lake") || title.includes("sea") || title.includes("island") || description.includes("beach") || description.includes("ocean")) {
      category = "Trending";
    } else if (title.includes("camp") || title.includes("treehouse") || title.includes("forest") || description.includes("camp") || description.includes("glamping")) {
      category = "Camping";
    } else if (title.includes("farm") || title.includes("barn") || title.includes("ranch") || title.includes("cow") || description.includes("farm") || description.includes("ranch")) {
      category = "Farms";
    } else if (title.includes("dome") || title.includes("igloo") || description.includes("dome")) {
      category = "Domes";
    } else if (title.includes("castle") || title.includes("fort") || title.includes("palace") || description.includes("castle") || description.includes("historic")) {
      category = "Castles";
    } else if (title.includes("boat") || title.includes("yacht") || title.includes("ship") || description.includes("boat") || description.includes("yacht")) {
      category = "Boats";
    } else if (title.includes("arctic") || title.includes("snow") || title.includes("ice") || description.includes("arctic") || description.includes("polar")) {
      category = "Arctic";
    }

    listing.category = category;
    await listing.save();
    updatedCount++;
  }

  console.log(`Migration complete! Successfully updated ${updatedCount} listings.`);
}
