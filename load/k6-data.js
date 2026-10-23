// Test data for the k6 runs, and the database check afterwards.
//
//   node load/k6-data.js seed                    # prints burst_listing=<id>
//   node load/k6-data.js verify <listingId> <units>   # after the burst
//
// Uses ATLASDB_URL. Meant for a throwaway database (CI's Compose stack):
// "seed" adds a host and listings, it doesn't delete anything.
require("../config/env.js");
const mongoose = require("mongoose");
const User = require("../models/user.js");
const Listing = require("../models/listing.js");
const Booking = require("../models/booking.js");
const InventoryNight = require("../models/inventoryNight.js");

// browse.js finds listings through search suggestions for "st", "in", "an",
// "la" and "ma"; these titles match all of them.
const BROWSE_TITLES = ["Stay in Manali Lakeside", "Coastal Stay, Mangalore", "Lantern Stay, Madurai", "Island Stay, Malvan", "Stanley Hall, Mahabaleshwar"];

async function seed() {
  const host = await User.register(new User({ username: `k6_host_${Date.now()}`, email: `k6host${Date.now()}@example.com`, role: "admin" }), "k6-host-password");
  const base = {
    description: "Load-test listing",
    image: { url: "https://res.cloudinary.com/demo/image/upload/sample.jpg", filename: "sample" },
    price: 2500,
    location: "Pune",
    country: "India",
    category: "Rooms",
    owner: host._id,
    geometry: { type: "Point", coordinates: [73.8563, 18.5157] },
  };
  await Listing.insertMany(BROWSE_TITLES.map((title) => ({ ...base, title, units: 3 })));
  // The contested listing: ONE unit, so at most one of the burst users may get it.
  const burst = await Listing.create({ ...base, title: "Last Room Standing", units: 1 });
  console.log(`burst_listing=${burst._id}`);
}

async function verify(listingId, units) {
  const active = await Booking.countDocuments({ listing: listingId, status: { $in: Booking.ACTIVE_STATUSES } });
  const nights = await InventoryNight.find({ listing: listingId }).lean();
  const bad = nights.filter((n) => n.reserved < 0 || n.reserved > units);
  console.log(`active bookings for the contested listing: ${active} (units: ${units})`);
  console.log(`inventory nights: ${nights.length}, reserved per night: ${nights.map((n) => n.reserved).join(", ") || "none"}`);
  // The burst has far more users than units, so EXACTLY units bookings must
  // succeed: more is an oversell, fewer means correct requests were lost.
  const ok = active === units && bad.length === 0;
  console.log(ok ? "PASS: exactly one booking per unit, no negative inventory" : `FAIL: ${active} active bookings for ${units} unit(s), ${bad.length} bad nights`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  await mongoose.connect(process.env.ATLASDB_URL, { serverSelectionTimeoutMS: 15_000 });
  const [mode, listingId, units] = process.argv.slice(2);
  if (mode === "seed") await seed();
  else if (mode === "verify") await verify(listingId, Number(units));
  else throw new Error("usage: data.js seed | verify <listingId> <units>");
})()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
