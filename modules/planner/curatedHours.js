// Checked opening hours for well-known attractions, which override (or fill
// in) what OpenStreetMap has. OpenStreetMap had hours for only 9-17% of
// places in the cities checked, and none for the Taj Mahal.
//
// Rules for adding an entry:
// - Only from an OFFICIAL source (the monument's own site, a .gov.in/.nic.in
//   tourism page), recorded in `source`.
// - When official sources disagree (they often do), use the NARROWEST window
//   they agree on, so the planner never sends someone when it might be shut.
// - A closed day only if an official source states it.
// - If it can't be confirmed, leave it out: the place then falls back to
//   OpenStreetMap or "typical hours, not confirmed".
// Checked: October 2026. Timings change; the plan tells guests to check.
const CHECKED = "2026-10";

// City reference points [lat, lng]; an entry only matches places within
// 30 km, so e.g. Jaipur's Jantar Mantar never takes Delhi's hours.
const CITIES = {
  agra: [27.1749, 78.0088],
  delhi: [28.6139, 77.209],
  jaipur: [26.9203, 75.8125],
  hyderabad: [17.3614, 78.4745],
  mumbai: [19.0778, 72.8787],
  pune: [18.5157, 73.8563],
  kolkata: [22.5568, 88.3547],
  bangalore: [12.9791, 77.5913],
  udaipur: [24.5822, 73.6966],
  varanasi: [25.3367, 83.007],
};

const CURATED = [
  {
    city: "agra",
    names: ["Taj Mahal"],
    openingHours: "Sa-Th (sunrise-00:30)-(sunset-00:30); Fr off",
    visitMinutes: 120,
    source: "https://www.tajmahal.gov.in/ (30 min before sunrise to 30 min before sunset; closed Fridays)",
  },
  {
    city: "agra",
    names: ["Agra Fort", "Red Fort Agra", "Red Fort, Agra"],
    openingHours: "sunrise-sunset",
    visitMinutes: 120,
    source: "https://agra.nic.in/tourist-place/agra-fort/ (sunrise to sunset, all days)",
  },
  {
    city: "delhi",
    names: ["Qutb Minar", "Qutub Minar", "Qutab Minar", "Qutb Complex"],
    openingHours: "sunrise-sunset",
    visitMinutes: 75,
    source: "https://asi.nic.in/pages/WorldHeritageQutbMinar (sunrise-8 pm) and incredibleindia.gov.in (sunrise-sunset): narrower used",
  },
  {
    city: "delhi",
    names: ["Humayun's Tomb", "Humayun Tomb", "Humayuns Tomb"],
    openingHours: "sunrise-sunset",
    visitMinutes: 75,
    source: "https://asi.nic.in/pages/WorldHeritageHumayunTomb (sunrise-9 pm); closing at sunset used as the safe bound",
  },
  {
    city: "jaipur",
    names: ["Amber Fort", "Amer Fort", "Amber Palace", "Amer Palace"],
    openingHours: "09:00-17:00",
    visitMinutes: 150,
    source: "incredibleindia.gov.in (9 am-6 pm) and obms-tourist.rajasthan.gov.in (7 am-5 pm, 8 am-9 pm): narrowest overlap used",
  },
  {
    city: "jaipur",
    names: ["Hawa Mahal"],
    openingHours: "09:00-16:30",
    visitMinutes: 45,
    source: "https://www.incredibleindia.gov.in/en/rajasthan/jaipur/hawa-mahal (9 am-4:30 pm)",
  },
  {
    city: "jaipur",
    names: ["Jantar Mantar"],
    openingHours: "09:00-16:30",
    visitMinutes: 60,
    source: "https://www.tourism.rajasthan.gov.in/jantar-mantar.html (9 am-4:30 pm; another section says 7 pm): narrower used",
  },
  {
    city: "jaipur",
    names: ["Albert Hall", "Albert Hall Museum", "Central Museum"],
    openingHours: "09:00-17:00,19:00-21:30",
    visitMinutes: 75,
    source: "https://www.incredibleindia.gov.in/en/rajasthan/jaipur/albert-hall-museum (9 am-5 pm and 7-9:30 pm)",
  },
  {
    city: "hyderabad",
    names: ["Salar Jung Museum", "Salarjung Museum"],
    openingHours: "Sa-Th 10:00-17:00; Fr off",
    visitMinutes: 120,
    source: "https://telanganatourism.gov.in (all days except Friday, 10 am-5 pm)",
  },
  {
    city: "hyderabad",
    names: ["Golconda Fort", "Golkonda Fort", "Golconda"],
    openingHours: "09:00-17:00",
    visitMinutes: 120,
    source: "https://telanganatourism.gov.in/partials/destinations/heritage-spots/hyderabad/golconda-fort.html (9 am-5 pm)",
  },
  {
    city: "hyderabad",
    names: ["Charminar"],
    openingHours: "09:00-17:00",
    visitMinutes: 45,
    source: "telanganatourism.gov.in (9 am-5:30 pm) and incredibleindia.gov.in (no entry after 5 pm): narrower used",
  },
  {
    city: "mumbai",
    names: ["Chhatrapati Shivaji Maharaj Vastu Sangrahalaya", "Prince of Wales Museum", "CSMVS"],
    openingHours: "10:15-18:00",
    visitMinutes: 120,
    source: "https://www.csmvs.in/visit-us.html (10:15 am-6 pm daily; the museum's own site)",
  },
  {
    city: "pune",
    names: ["Shaniwar Wada", "Shaniwarwada", "Shanivarwada"],
    openingHours: "Mo-Sa 09:30-17:00; Su off",
    visitMinutes: 60,
    source: "https://www.incredibleindia.gov.in/en/maharashtra/pune/shaniwar-wada (9:30 am-5 pm, closed Sundays)",
  },
  {
    city: "kolkata",
    names: ["Victoria Memorial", "Victoria Memorial Hall"],
    openingHours: "Tu-Su 10:00-18:00; Mo off",
    visitMinutes: 90,
    source: "https://victoriamemorial-cal.org/visit/index (gallery 10 am-6 pm, closed Mondays)",
  },
  {
    city: "kolkata",
    names: ["Indian Museum"],
    // Closed, not "unknown": the museum's own site says so. Don't send people there.
    openingHours: "off",
    visitMinutes: 120,
    source: "https://indianmuseumkolkata.org/visitors-information/ (galleries closed to the public during 2026)",
  },
  {
    city: "delhi",
    names: ["Akshardham", "Swaminarayan Akshardham", "Akshardham Temple"],
    openingHours: "Tu-Su 10:00-18:30; Mo off",
    visitMinutes: 150,
    source: "https://akshardham.com/visitor-info/ (Tue-Sun, first entry 10 am, last entry 6:30 pm; closed Mondays)",
  },
  {
    city: "bangalore",
    names: ["Lalbagh", "Lal Bagh", "Lalbagh Botanical Garden", "Lal Bagh Botanical Garden"],
    openingHours: "07:00-18:00",
    visitMinutes: 90,
    source: "karnatakatourism.org (6-6, 7-6) and incredibleindia.gov.in (6-7): narrowest overlap used",
  },
  {
    city: "bangalore",
    names: ["Bangalore Palace", "Bengaluru Palace"],
    openingHours: "10:00-17:30",
    visitMinutes: 75,
    source: "https://karnatakatourism.org/en/attractions/bangalore-palace/ (10 am-5:30 pm)",
  },
  {
    city: "udaipur",
    names: ["City Palace", "City Palace Udaipur", "City Palace, Udaipur"],
    openingHours: "09:30-17:30",
    visitMinutes: 120,
    source: "https://www.incredibleindia.gov.in/en/rajasthan/udaipur/city-palace (9:30 am-5:30 pm)",
  },
  {
    city: "varanasi",
    names: ["Sarnath Museum", "Archaeological Museum Sarnath", "Archaeological Museum, Sarnath"],
    openingHours: "Sa-Th 10:00-17:00; Fr off",
    visitMinutes: 60,
    source: "https://www.incredibleindia.gov.in/en/uttar-pradesh/varanasi/sarnath-museum (10 am-5 pm, closed Fridays)",
  },
];

const normalizeName = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function nearCity(place, city) {
  const [lat, lng] = CITIES[city];
  // ~0.27 degrees is about 30 km at these latitudes; plenty for a city.
  return Math.abs(place.lat - lat) < 0.27 && Math.abs(place.lng - lng) < 0.3;
}

const index = CURATED.map((entry) => ({ ...entry, keys: entry.names.map(normalizeName) }));

/** Returns the place with curated hours applied, if one matches. */
function applyCurated(place) {
  const names = [place.name, place.localName].map(normalizeName);
  const entry = index.find((e) => nearCity(place, e.city) && e.keys.some((k) => names.includes(k)));
  if (!entry) return place;
  return {
    ...place,
    openingHours: entry.openingHours,
    hoursSource: "curated",
    hoursNote: `${entry.source}; checked ${CHECKED}`,
    visitMinutes: entry.visitMinutes,
    score: place.score + 5, // the famous ones a first-time visitor shouldn't miss
  };
}

module.exports = { applyCurated, CURATED, CITIES, normalizeName };
