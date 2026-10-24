// The arrival-day planner's algorithm. Pure functions: no database, no
// network, so every rule is unit-tested with hand-made inputs.
//
// The problem: from the hotel, visit the most worthwhile places within a
// time window, each one while it's open (arrive, see it, and leave before
// it closes), and be back at the hotel by the end of the window. That's the
// "orienteering problem with time windows". It's NP-hard in general, but a
// window here holds at most ~12 candidates, so it's solved EXACTLY with
// dynamic programming over subsets:
//
//   best[visited set][last place] = earliest time we can finish seeing
//                                   "last" having seen exactly "visited"
//
// Earliest finish is the right thing to keep: arriving earlier never hurts,
// because you can always wait for a place to open. 2^12 sets x 12 places x
// 12 next places is about 600k steps: a few milliseconds.
const { legMinutes, modeBeforeCheckIn } = require("./modes.js");

const MAX_PLACES_PER_WINDOW = 12;
const DROP_BAGS_MINUTES = 15; // early arrivals leave luggage at the hotel first
const CHECK_IN_MINUTES = 30; // check-in formalities and freshening up

/** Earliest minute >= arrive at which a visit of `visit` minutes fits in one open interval. */
function earliestVisitStart(intervals, arrive, visit) {
  for (const [open, close] of intervals) {
    const start = Math.max(open, arrive);
    if (start + visit <= close) return start;
  }
  return null;
}

/**
 * Best route within one window. Node 0 is the hotel; node i is places[i-1].
 * @param {object} p
 * @param {number} p.start  minute the window starts (at the hotel)
 * @param {number} p.end    minute by which we must be back at the hotel
 * @param {Array}  p.places [{ key, name, visitMinutes, score, intervals }]
 * @param {(a: number, b: number) => number} p.travel door-to-door minutes
 */
function planWindow({ start, end, places, travel, maxPlaces = MAX_PLACES_PER_WINDOW }) {
  // Keep only places that are worth considering on their own: reachable,
  // open long enough after we could get there, with time to get back.
  const feasible = [];
  places.forEach((place, i) => {
    const node = i + 1;
    const arrive = start + travel(0, node);
    const visitStart = earliestVisitStart(place.intervals, arrive, place.visitMinutes);
    if (visitStart === null) return;
    if (visitStart + place.visitMinutes + travel(node, 0) > end) return;
    feasible.push({ place, node });
  });
  feasible.sort((a, b) => b.place.score - a.place.score || travel(0, a.node) - travel(0, b.node));
  const cand = feasible.slice(0, maxPlaces);
  const n = cand.length;
  if (n === 0) return { stops: [], leaveHotelAt: start, returnAt: start, score: 0 };

  const size = 1 << n;
  const finish = new Float64Array(size * n).fill(Infinity);
  const parent = new Int32Array(size * n).fill(-1);
  const at = (mask, last) => mask * n + last;

  for (let j = 0; j < n; j++) {
    const arrive = start + travel(0, cand[j].node);
    const s = earliestVisitStart(cand[j].place.intervals, arrive, cand[j].place.visitMinutes);
    if (s !== null) finish[at(1 << j, j)] = s + cand[j].place.visitMinutes;
  }

  let best = { score: 0, returnAt: start, mask: 0, last: -1 };
  const scoreOf = new Float64Array(size);
  for (let mask = 1; mask < size; mask++) {
    const low = mask & -mask;
    scoreOf[mask] = scoreOf[mask ^ low] + cand[31 - Math.clz32(low)].place.score;
    for (let last = 0; last < n; last++) {
      const done = finish[at(mask, last)];
      if (done === Infinity) continue;
      const returnAt = done + travel(cand[last].node, 0);
      if (returnAt > end) continue;
      // Most worthwhile set; on a tie, the one that gets back earliest.
      if (scoreOf[mask] > best.score || (scoreOf[mask] === best.score && returnAt < best.returnAt)) {
        best = { score: scoreOf[mask], returnAt, mask, last };
      }
      for (let next = 0; next < n; next++) {
        if (mask & (1 << next)) continue;
        const arrive = done + travel(cand[last].node, cand[next].node);
        const s = earliestVisitStart(cand[next].place.intervals, arrive, cand[next].place.visitMinutes);
        if (s === null) continue;
        const f = s + cand[next].place.visitMinutes;
        if (f + travel(cand[next].node, 0) > end) continue; // couldn't get back in time
        const key = at(mask | (1 << next), next);
        if (f < finish[key]) {
          finish[key] = f;
          parent[key] = last;
        }
      }
    }
  }

  // Walk the parent pointers back to recover the order.
  const order = [];
  let mask = best.mask;
  let last = best.last;
  while (last !== -1) {
    order.unshift(last);
    const prev = parent[at(mask, last)];
    mask ^= 1 << last;
    last = prev;
  }

  // Replay the route to produce the timetable.
  const stops = [];
  let clock = start;
  let fromNode = 0;
  for (const j of order) {
    const { place, node } = cand[j];
    const travelMinutes = travel(fromNode, node);
    const arrive = clock + travelMinutes;
    const visitStart = earliestVisitStart(place.intervals, arrive, place.visitMinutes);
    const leave = visitStart + place.visitMinutes;
    const closesAt = place.intervals.find(([o, c]) => visitStart >= o && leave <= c)[1];
    stops.push({ place, travelMinutes, arrive, wait: visitStart - arrive, start: visitStart, leave, closesAt });
    clock = leave;
    fromNode = node;
  }
  // Don't make the guest stand outside: if the first place isn't open yet,
  // leave the hotel later so they arrive as it opens. Nothing after it
  // moves, because that visit still starts at the same time.
  let leaveHotelAt = start;
  if (stops.length && stops[0].wait > 0) {
    leaveHotelAt = start + stops[0].wait;
    stops[0] = { ...stops[0], arrive: stops[0].start, wait: 0 };
  }
  return { stops, leaveHotelAt, returnAt: clock + travel(fromNode, 0), returnTravelMinutes: travel(fromNode, 0), score: best.score };
}

/**
 * The whole arrival day: an optional window before check-in (early
 * arrivals) and one after, without visiting a place twice.
 *
 * @param {object} p
 * @param {number} p.arrival      minute the guest reaches the hotel
 * @param {number} p.checkIn      hotel's check-in minute
 * @param {number} p.dayEnd       minute the guest wants to be back for the night
 * @param {string} p.mode         one of TRAVEL_MODES
 * @param {number} [p.rentalMinutes] time to pick up a rental after check-in
 * @param {Array}  p.places       [{ key, name, visitMinutes, score, intervals }]
 * @param {(mode: string) => (a: number, b: number) => number} p.rawTravel
 *        road-network minutes for a mode's routing profile (node 0 = hotel)
 */
function planDay({ arrival, checkIn, dayEnd, mode, rentalMinutes = 0, places, rawTravel }) {
  const travelFor = (m) => {
    const raw = rawTravel(m);
    return (a, b) => (a === b ? 0 : legMinutes(m, raw(a, b)));
  };
  const plan = { before: null, after: null, checkInAt: Math.max(arrival, checkIn) };

  const beforeStart = arrival + DROP_BAGS_MINUTES;
  if (beforeStart < checkIn) {
    const morningMode = modeBeforeCheckIn(mode);
    const result = planWindow({ start: beforeStart, end: checkIn, places, travel: travelFor(morningMode) });
    plan.before = { mode: morningMode, start: beforeStart, end: checkIn, ...result };
  }

  const seen = new Set((plan.before ? plan.before.stops : []).map((s) => s.place.key));
  const remaining = places.map((p) => (seen.has(p.key) ? null : p));
  const afterStart = plan.checkInAt + CHECK_IN_MINUTES + (mode === "rental" ? rentalMinutes : 0);
  if (afterStart < dayEnd) {
    // Keep node numbering stable (matrix indexes) by masking visited places
    // as never-open instead of removing them.
    const afterPlaces = remaining.map((p, i) => p || { ...places[i], intervals: [] });
    const result = planWindow({ start: afterStart, end: dayEnd, places: afterPlaces, travel: travelFor(mode) });
    plan.after = { mode, start: afterStart, end: dayEnd, rentalMinutes: mode === "rental" ? rentalMinutes : 0, ...result };
  }
  return plan;
}

module.exports = { planWindow, planDay, earliestVisitStart, DROP_BAGS_MINUTES, CHECK_IN_MINUTES, MAX_PLACES_PER_WINDOW };
