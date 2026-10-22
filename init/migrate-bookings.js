// One-off: move pre-Milestone-2 bookings onto the inventory model.
//
//   npm run migrate:bookings            # dry run: report only, changes nothing
//   npm run migrate:bookings -- --apply # write the changes
//
// Safe to run more than once: it only touches bookings that have no status yet.
const { config, assertRequired } = require("../config/env.js");
const mongoose = require("mongoose");
const { ensureIndexes } = require("../modules/bookings/service.js");
const { migrateLegacyBookings } = require("../modules/bookings/migrateLegacy.js");

async function main() {
  const apply = process.argv.includes("--apply");
  assertRequired();
  await mongoose.connect(config.dbUrl, { serverSelectionTimeoutMS: 10_000 });
  await ensureIndexes();

  const report = await migrateLegacyBookings({ apply });
  console.log(apply ? "APPLIED" : "DRY RUN (nothing written; re-run with --apply)");
  console.log(`Legacy bookings found: ${report.scanned}`);
  console.log(`Would migrate / migrated: ${report.migrated} (of which past stays: ${report.pastStays})`);
  if (report.conflicts.length) {
    console.log(`Conflicts needing manual action: ${report.conflicts.length}`);
    console.table(report.conflicts);
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
