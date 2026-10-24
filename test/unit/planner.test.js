// Arrival-day planner: scheduling rules, opening hours, travel modes.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planWindow, planDay, earliestVisitStart } = require("../../modules/planner/scheduler.js");
const { openIntervals } = require("../../modules/planner/hours.js");
const { legMinutes, modeBeforeCheckIn } = require("../../modules/planner/modes.js");
const { toMinutes, formatMinutes } = require("../../modules/planner/time.js");
const { resolveSunTimes } = require("../../modules/planner/hours.js");
const { applyCurated } = require("../../modules/planner/curatedHours.js");

const t = toMinutes;
const ALL_DAY = [[0, 1440]];
const place = (key, { score = 1, visit = 60, intervals = ALL_DAY } = {}) => ({ key, name: key, score, visitMinutes: visit, intervals });
// Symmetric travel matrix from a list of rows (node 0 = hotel).
const matrix = (rows) => (a, b) => rows[a][b];

test("time helpers", () => {
  assert.equal(t("07:30"), 450);
  assert.equal(formatMinutes(450), "7:30 am");
  assert.equal(formatMinutes(t("12:00")), "12:00 pm");
  assert.equal(formatMinutes(t("00:15")), "12:15 am");
  assert.throws(() => t("7:30"), /HH:MM/);
});

test("opening hours: closed day, unknown hours, sun times, 24/7", () => {
  // 2026-11-05 is a Thursday, 2026-11-06 a Friday.
  assert.deepEqual(openIntervals("Sa-Th 06:00-18:30; Fr off", "2026-11-05"), { intervals: [[360, 1110]], confirmed: true });
  assert.deepEqual(openIntervals("Sa-Th 06:00-18:30; Fr off", "2026-11-06").intervals, [], "closed on Friday");
  assert.deepEqual(openIntervals(null, "2026-11-06"), { intervals: [[540, 1080]], confirmed: false }, "unknown -> typical hours, flagged");
  assert.deepEqual(openIntervals("sunrise-sunset", "2026-11-06").intervals, [[360, 1080]]);
  assert.deepEqual(openIntervals("24/7", "2026-11-06").intervals, [[0, 1440]]);
  assert.deepEqual(openIntervals("Mo-Su 10:00-13:00,14:00-17:00", "2026-11-06").intervals, [[600, 780], [840, 1020]], "lunch break");
});

test("travel modes turn road time into door-to-door time", () => {
  assert.equal(legMinutes("cab", 20), 30, "+10 min waiting for the cab");
  assert.equal(legMinutes("public_transport", 20), 51, "1.8x + 15 min, rounded up");
  assert.equal(legMinutes("walking", 20), 20);
  assert.equal(legMinutes("cab", 0), 0);
  assert.equal(modeBeforeCheckIn("rental"), "cab", "the rental isn't picked up until after check-in");
  assert.equal(modeBeforeCheckIn("walking"), "walking");
});

test("a visit must fit inside one open interval", () => {
  assert.equal(earliestVisitStart([[540, 1020]], 480, 60), 540, "waits for opening");
  assert.equal(earliestVisitStart([[540, 1020]], 990, 60), null, "too close to closing time");
  assert.equal(earliestVisitStart([[600, 780], [840, 1020]], 750, 60), 840, "skips to the afternoon session");
});

test("early arrival: sees nearby places, is back for check-in, nothing repeated after", () => {
  // Hotel(0), A and B near the hotel, C far away.
  const travel = matrix([
    [0, 10, 15, 60],
    [10, 0, 10, 55],
    [15, 10, 0, 50],
    [60, 55, 50, 0],
  ]);
  const places = [place("A", { score: 3 }), place("B", { score: 2 }), place("C", { score: 5, visit: 90 })];
  const plan = planDay({
    arrival: t("07:00"),
    checkIn: t("12:00"),
    dayEnd: t("21:00"),
    mode: "walking",
    places,
    rawTravel: () => travel,
  });
  assert.ok(plan.before, "a morning plan exists");
  assert.ok(plan.before.returnAt <= t("12:00"), "back at the hotel by check-in");
  assert.equal(plan.checkInAt, t("12:00"));
  const morning = plan.before.stops.map((s) => s.place.key);
  const afternoon = plan.after.stops.map((s) => s.place.key);
  assert.equal(morning.filter((k) => afternoon.includes(k)).length, 0, "no place visited twice");
  assert.deepEqual([...morning, ...afternoon].sort(), ["A", "B", "C"], "the day fits all three");
  assert.ok(plan.after.returnAt <= t("21:00"));
});

test("closing times: a place is only scheduled if the visit ends before it closes", () => {
  const travel = matrix([
    [0, 30],
    [30, 0],
  ]);
  const museum = place("Museum", { visit: 90, intervals: [[t("10:00"), t("17:00")]] });
  // Free from 15:00: arrive 15:30, 90 min visit ends 17:00 exactly -> fits.
  const fits = planWindow({ start: t("15:00"), end: t("21:00"), places: [museum], travel });
  assert.equal(fits.stops.length, 1);
  assert.equal(fits.stops[0].leave, t("17:00"));
  assert.equal(fits.stops[0].closesAt, t("17:00"));
  // Free from 15:01: the visit would end after closing -> skipped.
  const late = planWindow({ start: t("15:01"), end: t("21:00"), places: [museum], travel });
  assert.equal(late.stops.length, 0);
});

test("closed days are respected (Taj Mahal on a Friday)", () => {
  const travel = matrix([
    [0, 20],
    [20, 0],
  ]);
  const taj = (date) => ({ ...place("Taj"), intervals: openIntervals("Sa-Th 06:00-18:30; Fr off", date).intervals });
  assert.equal(planWindow({ start: t("13:00"), end: t("21:00"), places: [taj("2026-11-06")], travel }).stops.length, 0, "Friday");
  assert.equal(planWindow({ start: t("13:00"), end: t("21:00"), places: [taj("2026-11-05")], travel }).stops.length, 1, "Thursday");
});

test("rental: the afternoon starts after picking up the vehicle; the morning is by cab", () => {
  const raw = matrix([
    [0, 10],
    [10, 0],
  ]);
  const used = [];
  const plan = planDay({
    arrival: t("08:00"),
    checkIn: t("12:00"),
    dayEnd: t("20:00"),
    mode: "rental",
    rentalMinutes: 45,
    places: [place("A")],
    rawTravel: (m) => {
      used.push(m);
      return raw;
    },
  });
  assert.equal(plan.before.mode, "cab");
  assert.equal(plan.after.mode, "rental");
  assert.deepEqual(used, ["cab", "rental"]);
  assert.equal(plan.after.start, t("12:00") + 30 + 45, "check-in 30 min + rental 45 min");
});

test("late arrival: no morning window, check-in when they arrive", () => {
  const raw = matrix([
    [0, 10],
    [10, 0],
  ]);
  const plan = planDay({ arrival: t("15:30"), checkIn: t("12:00"), dayEnd: t("21:00"), mode: "cab", places: [place("A")], rawTravel: () => raw });
  assert.equal(plan.before, null);
  assert.equal(plan.checkInAt, t("15:30"));
  assert.equal(plan.after.start, t("16:00"));
});

test("arriving after the day ends gives an empty plan, not an error", () => {
  const raw = matrix([
    [0, 10],
    [10, 0],
  ]);
  const plan = planDay({ arrival: t("22:00"), checkIn: t("12:00"), dayEnd: t("21:00"), mode: "cab", places: [place("A")], rawTravel: () => raw });
  assert.equal(plan.before, null);
  assert.equal(plan.after, null);
});

test("it finds the best route, not just the nearest-first one", () => {
  // Greedy "nearest first" goes to N (score 1, 5 min away), after which the
  // two big places no longer fit. The best plan skips N.
  const travel = matrix([
    [0, 5, 60, 60],
    [5, 0, 100, 100],
    [60, 100, 0, 10],
    [60, 100, 10, 0],
  ]);
  const places = [place("N", { score: 1, visit: 30 }), place("Big1", { score: 5 }), place("Big2", { score: 5 })];
  const r = planWindow({ start: 0, end: 260, places, travel });
  assert.deepEqual(r.stops.map((s) => s.place.key).sort(), ["Big1", "Big2"]);
  assert.equal(r.score, 10);
});

// Brute force: try every order of every subset and keep the best score.
function bruteForce({ start, end, places, travel }) {
  let best = 0;
  const n = places.length;
  const go = (node, clock, used, score) => {
    if (clock + travel(node, 0) <= end) best = Math.max(best, score);
    for (let j = 0; j < n; j++) {
      if (used & (1 << j)) continue;
      const s = earliestVisitStart(places[j].intervals, clock + travel(node, j + 1), places[j].visitMinutes);
      if (s === null) continue;
      go(j + 1, s + places[j].visitMinutes, used | (1 << j), score + places[j].score);
    }
  };
  go(0, start, 0, 0);
  return best;
}

test("matches brute force on 300 random small instances (exact, not a heuristic)", () => {
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let trial = 0; trial < 300; trial++) {
    const n = 1 + Math.floor(rand() * 6);
    const pts = Array.from({ length: n + 1 }, () => [rand() * 40, rand() * 40]);
    const travel = (a, b) => Math.round(Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]));
    const places = Array.from({ length: n }, (_, i) => {
      const open = Math.floor(rand() * 600);
      return place(`P${i}`, { score: 1 + Math.floor(rand() * 5), visit: 20 + Math.floor(rand() * 60), intervals: [[open, open + 60 + Math.floor(rand() * 400)]] });
    });
    const start = Math.floor(rand() * 300);
    const end = start + 60 + Math.floor(rand() * 400);
    const dp = planWindow({ start, end, places, travel });
    assert.equal(dp.score, bruteForce({ start, end, places, travel }), `trial ${trial}`);
    // Every returned plan is actually valid.
    for (const s of dp.stops) assert.ok(s.leave <= s.closesAt && s.start >= s.arrive);
    assert.ok(dp.returnAt <= end);
  }
});

test("sunrise/sunset are the place's real local times, whatever the server's time zone", () => {
  // Agra, 5 Nov 2026: sunrise 06:30, sunset 17:32 IST. The Taj Mahal opens
  // 30 min before sunrise and closes 30 min before sunset.
  const agra = { lat: 27.1751, lng: 78.0421 };
  assert.equal(resolveSunTimes("Sa-Th (sunrise-00:30)-(sunset-00:30); Fr off", "2026-11-05", agra), "Sa-Th 06:00-17:02; Fr off");
  const { intervals } = openIntervals("Sa-Th (sunrise-00:30)-(sunset-00:30); Fr off", "2026-11-05", agra);
  assert.deepEqual(intervals, [[360, 1022]]);
});

test("curated hours only apply in their own city", () => {
  const jaipurJM = applyCurated({ name: "Jantar Mantar", lat: 26.9248, lng: 75.8246, score: 2 });
  assert.equal(jaipurJM.hoursSource, "curated");
  assert.equal(jaipurJM.openingHours, "09:00-16:30");
  // Delhi also has a Jantar Mantar; Jaipur's hours must not leak to it.
  const delhiJM = applyCurated({ name: "Jantar Mantar", lat: 28.6271, lng: 77.2166, score: 2, hoursSource: "typical" });
  assert.equal(delhiJM.hoursSource, "typical");
  // Matching ignores case and punctuation, and checks local names too.
  assert.equal(applyCurated({ name: "Humayuns tomb", lat: 28.5933, lng: 77.2507, score: 2 }).hoursSource, "curated");
  assert.equal(applyCurated({ name: "Charminar Bus Stop", lat: 17.3616, lng: 78.4747, score: 1, hoursSource: "typical" }).hoursSource, "typical", "no partial-name matches");
});
