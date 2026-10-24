// Tourist places near a hotel, from OpenStreetMap (Overpass API).
//
// OpenStreetMap is good at WHICH places exist and WHERE; it rarely has
// opening hours (3 of 33 places in Agra, 6 of 35 in Jaipur when checked).
// So hours for well-known attractions come from curatedHours.js, and the
// rest are scheduled within "typical hours" and labelled as unconfirmed.
const PlaceCache = require("../../models/placeCache.js");
const { applyCurated } = require("./curatedHours.js");
const { logger } = require("../observability/logger.js");
const { haversine } = require("./geo.js");

const CACHE_VERSION = 1;
const CACHE_DAYS = 14;
const RADIUS_METERS = 10_000;
const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
// Overpass usage policy: identify the client.
const USER_AGENT = "TravelByChance/1.0 (portfolio project; https://github.com/Mmeghna10/travel-by-chance)";

const TOURISM = ["attraction", "museum", "viewpoint", "zoo", "theme_park", "gallery"];
const HISTORIC = ["monument", "castle", "fort", "memorial", "ruins", "archaeological_site", "palace", "tomb"];

// How long people typically spend, and how interesting a kind of place is
// on its own (before notability bonuses).
const KINDS = {
  museum: { visit: 90, score: 3 },
  gallery: { visit: 60, score: 2 },
  zoo: { visit: 120, score: 2 },
  theme_park: { visit: 180, score: 2 },
  fort: { visit: 120, score: 4 },
  castle: { visit: 120, score: 4 },
  palace: { visit: 90, score: 4 },
  tomb: { visit: 45, score: 3 },
  archaeological_site: { visit: 60, score: 3 },
  ruins: { visit: 45, score: 2 },
  monument: { visit: 30, score: 2 },
  attraction: { visit: 45, score: 2 },
  viewpoint: { visit: 30, score: 2 },
  memorial: { visit: 20, score: 1 },
};

function overpassQuery(lat, lng, radius = RADIUS_METERS) {
  const around = `around:${radius},${lat},${lng}`;
  return `[out:json][timeout:90];
(
  nwr(${around})["tourism"~"^(${TOURISM.join("|")})$"]["name"];
  nwr(${around})["historic"~"^(${HISTORIC.join("|")})$"]["name"];
);
out center tags;`;
}

/** One OpenStreetMap element -> a place the planner understands. */
function normalize(el) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  const name = tags["name:en"] || tags.int_name || tags.name;
  if (lat == null || lng == null || !name) return null;
  const kind = KINDS[tags.historic] ? tags.historic : KINDS[tags.tourism] ? tags.tourism : "attraction";
  let score = KINDS[kind].score;
  if (tags.wikidata) score += 3; // notable enough for Wikidata
  if (tags.wikipedia) score += 2;
  return {
    key: `osm:${el.type}/${el.id}`,
    name,
    localName: tags.name && tags.name !== name ? tags.name : undefined,
    kind,
    lat,
    lng,
    wikidata: tags.wikidata,
    openingHours: tags.opening_hours || null,
    hoursSource: tags.opening_hours ? "openstreetmap" : "typical",
    visitMinutes: KINDS[kind].visit,
    score,
  };
}

/**
 * Normalise, apply curated hours, and drop near-duplicates: OpenStreetMap
 * often has the same monument twice (e.g. an English and a Hindi entry, or a
 * node inside the outline). Within 150 m, only the best-scored one is kept.
 */
function toPlaces(elements) {
  const places = elements.map(normalize).filter(Boolean).map(applyCurated);
  places.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const p of places) {
    if (kept.some((k) => (p.wikidata && k.wikidata === p.wikidata) || haversine(p.lat, p.lng, k.lat, k.lng) < 150)) continue;
    kept.push(p);
  }
  return kept;
}

async function fetchFromOverpass(lat, lng, { fetchImpl = fetch } = {}) {
  let lastError;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
        body: "data=" + encodeURIComponent(overpassQuery(lat, lng)),
        signal: AbortSignal.timeout(100_000),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const body = await res.json();
      return body.elements || [];
    } catch (err) {
      lastError = err;
      logger.warn({ err: err.message, url }, "overpass request failed; trying the next server");
    }
  }
  throw lastError;
}

const cacheKey = (lat, lng) => `${lat.toFixed(3)},${lng.toFixed(3)},${RADIUS_METERS},v${CACHE_VERSION}`;
const inFlight = new Map(); // key -> promise, so one process asks Overpass once
const recentFailures = new Map(); // key -> { error, at }

/**
 * Places near (lat, lng). Never waits for OpenStreetMap on a cold cache:
 * returns { status: "pending" } and fetches in the background, so the page
 * can poll. Returns { status: "ready", places } from the cache otherwise.
 */
async function placesNear(lat, lng, { fetchElements = fetchFromOverpass, now = () => new Date() } = {}) {
  const key = cacheKey(lat, lng);
  const cached = await PlaceCache.findById(key).lean();
  if (cached && cached.expiresAt > now()) return { status: "ready", places: cached.places, fetchedAt: cached.fetchedAt };

  const failure = recentFailures.get(key);
  if (failure && now() - failure.at < 60_000 && !inFlight.has(key)) {
    return { status: "failed", error: failure.error };
  }
  if (!inFlight.has(key)) {
    const job = (async () => {
      try {
        const places = toPlaces(await fetchElements(lat, lng));
        const fetchedAt = now();
        await PlaceCache.updateOne(
          { _id: key },
          { $set: { places, fetchedAt, expiresAt: new Date(fetchedAt.getTime() + CACHE_DAYS * 86_400_000) } },
          { upsert: true },
        );
        recentFailures.delete(key);
        logger.info({ key, places: places.length }, "places fetched from OpenStreetMap");
      } catch (err) {
        recentFailures.set(key, { error: "Couldn't reach OpenStreetMap. Please try again in a minute.", at: now() });
        logger.warn({ err: err.message, key }, "places fetch failed");
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, job);
  }
  return { status: "pending" };
}

/** For tests: forget in-flight fetches and remembered failures. */
function resetPlacesState() {
  inFlight.clear();
  recentFailures.clear();
}

/** For scripts and tests: wait for any background fetch of this point. */
async function settle(lat, lng) {
  await inFlight.get(cacheKey(lat, lng));
}

module.exports = { placesNear, settle, resetPlacesState, toPlaces, normalize, overpassQuery, haversine, fetchFromOverpass, KINDS, RADIUS_METERS };
