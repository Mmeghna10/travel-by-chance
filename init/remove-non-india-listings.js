// One-off: TravelByChance lists stays in India only. Removes listings in
// other countries (their reviews and inventory counters go with them).
//
//   npm run remove:non-india            # dry run: lists what would be removed
//   npm run remove:non-india -- --apply # back up to backups/, then remove
//
// Listings with an active or upcoming booking are kept and reported; a JSON
// backup is written before anything is removed. Safe to run more than once.
// Logic and tests: modules/listings/removeOutsideIndia.js, test/indiaOnly.test.js.
const path = require("path");
const { config, assertRequired } = require("../config/env.js");
const mongoose = require("mongoose");
const { removeListingsOutsideIndia } = require("../modules/listings/removeOutsideIndia.js");

async function main() {
  const apply = process.argv.includes("--apply");
  assertRequired();
  await mongoose.connect(config.dbUrl, { serverSelectionTimeoutMS: 10_000 });
  const db = mongoose.connection.db.databaseName;

  const report = await removeListingsOutsideIndia({ apply, backupDir: path.join(__dirname, "..", "backups"), label: db });
  console.log(`${apply ? "APPLY" : "DRY RUN (nothing removed; re-run with --apply)"} on database "${db}"`);
  console.log(`Listings outside India: ${report.found.length}; removable: ${report.removable.length}; kept (active bookings): ${report.blocked.length}`);
  if (report.found.length) console.table(report.found.map((l) => ({ title: l.title, location: `${l.location}, ${l.country}` })));
  if (report.blocked.length) {
    console.log("Kept because they have active or upcoming bookings (handle these first):");
    console.table(report.blocked.map(({ listing, activeBookings }) => ({ title: listing.title, activeBookings })));
  }
  if (report.backupFile) console.log(`Backup written: ${report.backupFile}`);
  if (apply) console.log(`Removed: ${report.removed}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
