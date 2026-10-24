// Travel times between the hotel and candidate places: one Mapbox Matrix API
// call gives the road-network time between EVERY pair (that's what the
// scheduler needs: hotel -> A -> C -> B -> hotel in any order).
//
// If Mapbox can't be reached (or there's no token), times are estimated
// from straight-line distance, and the plan says so.
const TravelCache = require("../../models/travelCache.js");
const { haversine } = require("./geo.js");
const { logger } = require("../observability/logger.js");

const MAX_POINTS = 16; // hotel + 15 places = 256 matrix elements per call
const CACHE_HOURS = 24;
// Fallback: roads are ~35% longer than the straight line; average city speeds.
const ROAD_FACTOR = 1.35;
const KMH = { driving: 25, walking: 4.5 };

function estimate(points, profile) {
  const km = points.map((a) => points.map((b) => (haversine(a.lat, a.lng, b.lat, b.lng) / 1000) * ROAD_FACTOR));
  const minutes = km.map((row) => row.map((d) => Math.ceil((d / KMH[profile]) * 60)));
  return { minutes, km, source: "estimate" };
}

async function fromMapbox(points, profile, { token, fetchImpl }) {
  const coords = points.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
  const url = `https://api.mapbox.com/directions-matrix/v1/mapbox/${profile}/${coords}?annotations=duration,distance&access_token=${encodeURIComponent(token)}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  const body = await res.json();
  if (!res.ok || body.code !== "Ok") throw new Error(`Mapbox matrix: ${res.status} ${body.code || body.message}`);
  // null = no route found between two points; treat as unreachable.
  const minutes = body.durations.map((row) => row.map((s) => (s == null ? 24 * 60 : Math.ceil(s / 60))));
  const km = body.distances.map((row) => row.map((m) => (m == null ? 999 : Math.round(m / 100) / 10)));
  return { minutes, km, source: "mapbox" };
}

/**
 * @param {{lat: number, lng: number}[]} points  points[0] is the hotel
 * @param {"driving"|"walking"} profile
 * @returns {{ minutes: number[][], km: number[][], source: "mapbox"|"estimate" }}
 */
async function travelMatrix(points, profile, { token = process.env.MAP_TOKEN, fetchImpl = fetch, now = () => new Date() } = {}) {
  if (points.length > MAX_POINTS) throw new Error(`At most ${MAX_POINTS} points per matrix`);
  const key = `${profile}:` + points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(";");
  const cached = await TravelCache.findById(key).lean();
  if (cached && cached.expiresAt > now()) return { minutes: cached.minutes, km: cached.km, source: cached.source };

  let result;
  try {
    if (!token) throw new Error("no MAP_TOKEN");
    result = await fromMapbox(points, profile, { token, fetchImpl });
  } catch (err) {
    logger.warn({ err: err.message }, "travel times: Mapbox unavailable, using distance estimates");
    // Not cached: the next request should try Mapbox again.
    return estimate(points, profile);
  }
  await TravelCache.updateOne(
    { _id: key },
    { $set: { ...result, expiresAt: new Date(now().getTime() + CACHE_HOURS * 3_600_000) } },
    { upsert: true },
  );
  return result;
}

module.exports = { travelMatrix, estimate, MAX_POINTS };
