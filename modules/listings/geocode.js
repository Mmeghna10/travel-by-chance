// Turning "Malibu, United States" into map coordinates (Mapbox geocoding), in
// one place for the admin listing form, the seed script and the repair script.
const mbxGeocoding = require("@mapbox/mapbox-sdk/services/geocoding");
const Listing = require("../../models/listing.js");

// The old seed script gave EVERY listing these coordinates (central Delhi),
// so every map showed Delhi. [0, 0] is what the listing form stores when a
// lookup finds nothing. Both mean "location unknown".
const SEED_PLACEHOLDER = [77.209, 28.613];
const NOT_FOUND = [0, 0];
const UNKNOWN_LOCATIONS = [SEED_PLACEHOLDER, NOT_FOUND];

const same = (a = "", b = "") => a.trim().toLowerCase() === b.trim().toLowerCase();

// The country a Mapbox result is in: the result itself if it IS a country,
// otherwise the country in its context (city -> region -> country).
function countryOf(feature) {
  if ((feature.place_type || []).includes("country")) return feature.text;
  const country = (feature.context || []).find((c) => String(c.id).startsWith("country."));
  return country && country.text;
}

/**
 * Returns geocode(query, { country }) -> GeoJSON Point, or null when nothing
 * matches. With a country, a match in any OTHER country counts as no match:
 * fuzzy search otherwise turns "Fiji, Fiji" into a town in Taiwan.
 * The Mapbox client is created on first use, so loading this module never
 * needs a token (tests, scripts that don't geocode).
 */
function createGeocoder(accessToken = process.env.MAP_TOKEN) {
  let client;
  return async function geocode(query, { country } = {}) {
    client ??= mbxGeocoding({ accessToken });
    const res = await client.forwardGeocode({ query, limit: 1 }).send();
    const feature = res.body.features && res.body.features[0];
    if (!feature) return null;
    if (country && !same(countryOf(feature), country)) return null;
    return { type: "Point", coordinates: feature.geometry.coordinates };
  };
}

// "Malibu, United States"; just "Maldives" when the place IS the country
// ("Maldives, Maldives" matched a street in Australia).
const placeQuery = ({ location, country }) =>
  location && country && same(location, country) ? country : [location, country].filter(Boolean).join(", ");

/**
 * Finds listings whose map location is unknown (the seed placeholder or
 * [0, 0]) and looks up their real coordinates from location + country.
 * Dry run unless apply is true. Safe to re-run: fixed listings no longer match.
 * The update is conditional on the coordinates still being the unknown ones,
 * so it never overwrites a location an admin set in the meantime.
 */
async function repairListingLocations({ geocode, apply = false }) {
  const listings = await Listing.find({
    $or: UNKNOWN_LOCATIONS.map((coordinates) => ({ "geometry.coordinates": coordinates })),
  })
    .select("title location country geometry")
    .lean();

  const report = { scanned: listings.length, fixed: 0, notFound: [], failed: [], changes: [] };
  // One at a time: 41 lookups is quick, and it stays well inside Mapbox's rate limits.
  for (const listing of listings) {
    const query = placeQuery(listing);
    let geometry;
    try {
      geometry = await geocode(query, { country: listing.country });
    } catch (err) {
      report.failed.push({ title: listing.title, query, error: err.message });
      continue;
    }
    if (!geometry) {
      report.notFound.push({ title: listing.title, query });
      continue;
    }
    report.changes.push({ title: listing.title, query, coordinates: geometry.coordinates.map((n) => +n.toFixed(4)).join(", ") });
    if (apply) {
      const res = await Listing.updateOne(
        { _id: listing._id, "geometry.coordinates": listing.geometry.coordinates },
        { $set: { geometry } },
      );
      if (res.modifiedCount === 1) report.fixed++;
    }
  }
  return report;
}

module.exports = { createGeocoder, repairListingLocations, placeQuery, countryOf, SEED_PLACEHOLDER, NOT_FOUND };
