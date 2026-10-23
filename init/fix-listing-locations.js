// One-off: give listings with an unknown map location (the old seed's Delhi
// placeholder, or [0, 0] from a failed lookup) their real coordinates, looked
// up from "location, country" with Mapbox.
//
//   npm run fix:locations            # dry run: shows what it would change
//   npm run fix:locations -- --apply # write the changes
//
// Safe to run more than once: listings that already have a location are skipped.
const { config, assertRequired } = require("../config/env.js");
const mongoose = require("mongoose");
const { createGeocoder, repairListingLocations } = require("../modules/listings/geocode.js");

async function main() {
  const apply = process.argv.includes("--apply");
  assertRequired();
  if (!process.env.MAP_TOKEN) throw new Error("MAP_TOKEN is required to look up locations");
  await mongoose.connect(config.dbUrl, { serverSelectionTimeoutMS: 10_000 });

  const report = await repairListingLocations({ geocode: createGeocoder(), apply });
  console.log(apply ? "APPLIED" : "DRY RUN (nothing written; re-run with --apply)");
  console.log(`Listings with an unknown location: ${report.scanned}`);
  if (report.changes.length) console.table(report.changes);
  if (apply) console.log(`Updated: ${report.fixed}`);
  if (report.notFound.length) {
    console.log(`No match (left unchanged): ${report.notFound.length}`);
    console.table(report.notFound);
  }
  if (report.failed.length) {
    console.log(`Lookup errors (left unchanged; re-run later): ${report.failed.length}`);
    console.table(report.failed);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
