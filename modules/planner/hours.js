// When is a place open on a given day? Parses OpenStreetMap's opening_hours
// syntax ("Sa-Th 06:00-18:30; Fr off") with the reference parser used by
// OSM tools, and returns open intervals in minutes after local midnight.
const OpeningHours = require("opening_hours");
const SunCalc = require("suncalc");

// Most places in OpenStreetMap have no hours (9-17% in the cities checked).
// They're scheduled within these "typical" hours and the plan says the
// times are not confirmed.
const TYPICAL_HOURS = "09:00-18:00";
const HOTEL_TIME_ZONE = "Asia/Kolkata"; // the planner covers Indian cities

const localHHMM = (date, timeZone) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
const pad = (n) => String(n).padStart(2, "0");

/**
 * Replaces sunrise/sunset (and "(sunset-00:30)" style offsets) with that
 * day's actual local times at the place. The parser itself would compute
 * them in the SERVER's time zone (it uses local Date methods), which is
 * wrong on a UTC server, so they're resolved here instead.
 */
function resolveSunTimes(value, isoDate, { lat, lng, timeZone = HOTEL_TIME_ZONE } = {}) {
  if (!/sunrise|sunset/.test(value)) return value;
  const [y, m, d] = isoDate.split("-").map(Number);
  let times = { sunrise: "06:00", sunset: "18:00" }; // without coordinates
  if (lat != null && lng != null) {
    // Midday UTC is on the right local date anywhere in India.
    const sun = SunCalc.getTimes(new Date(Date.UTC(y, m - 1, d, 6, 30)), lat, lng);
    times = { sunrise: localHHMM(sun.sunrise, timeZone), sunset: localHHMM(sun.sunset, timeZone) };
  }
  const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  const fmt = (min) => {
    const c = Math.min(Math.max(min, 0), 23 * 60 + 59);
    return `${pad(Math.floor(c / 60))}:${pad(c % 60)}`;
  };
  return value
    .replace(/\(\s*(sunrise|sunset)\s*([+-])\s*(\d\d):(\d\d)\s*\)/g, (_, which, sign, hh, mm) => {
      const offset = Number(hh) * 60 + Number(mm);
      return fmt(toMin(times[which]) + (sign === "+" ? offset : -offset));
    })
    .replace(/sunrise|sunset/g, (which) => times[which]);
}

function intervalsFor(value, isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dayStart = new Date(y, m - 1, d, 0, 0);
  const dayEnd = new Date(y, m - 1, d + 1, 0, 0);
  const oh = new OpeningHours(value, null, { mode: 0 });
  return oh
    .getOpenIntervals(dayStart, dayEnd)
    .map(([start, end]) => [Math.round((start - dayStart) / 60000), Math.round((end - dayStart) / 60000)])
    .filter(([s, e]) => e > s);
}

/**
 * @param {string|null} value  opening_hours string, or null if unknown
 * @param {string} isoDate     "YYYY-MM-DD", the day of the visit
 * @param {{lat?: number, lng?: number}} [where] for sunrise/sunset
 * @returns {{ intervals: number[][], confirmed: boolean }}
 *   intervals: [[openMinute, closeMinute], ...]; empty = closed all day.
 *   confirmed: false when the hours are our "typical hours" guess.
 */
function openIntervals(value, isoDate, where) {
  if (value) {
    try {
      return { intervals: intervalsFor(resolveSunTimes(value, isoDate, where), isoDate), confirmed: true };
    } catch {
      // Unparseable value in OpenStreetMap: treat like unknown hours.
    }
  }
  return { intervals: intervalsFor(TYPICAL_HOURS, isoDate), confirmed: false };
}

module.exports = { openIntervals, resolveSunTimes, TYPICAL_HOURS, HOTEL_TIME_ZONE };
