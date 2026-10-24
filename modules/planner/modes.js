// How the guest gets around, and how that turns a road-network travel time
// into a door-to-door estimate.
//
// Mapbox gives real driving and walking times. It has no public-transport
// routing for these cities, so public transport is an ESTIMATE derived from
// the driving time (buses stop and detour) plus waiting time, and the plan
// labels it as such.
const TRAVEL_MODES = ["own_vehicle", "rental", "cab", "public_transport", "walking"];

const MODES = {
  own_vehicle: { label: "Own vehicle", profile: "driving", factor: 1, overheadMinutes: 5, note: "includes ~5 min to park" },
  rental: { label: "Rented vehicle", profile: "driving", factor: 1, overheadMinutes: 5, note: "includes ~5 min to park" },
  cab: { label: "Cab", profile: "driving", factor: 1, overheadMinutes: 10, note: "includes ~10 min waiting for the cab" },
  public_transport: {
    label: "Public transport",
    profile: "driving",
    factor: 1.8,
    overheadMinutes: 15,
    note: "estimate: 1.8x the driving time plus ~15 min waiting",
  },
  walking: { label: "Walking", profile: "walking", factor: 1, overheadMinutes: 0, note: "" },
};

/** Door-to-door minutes for one leg, from the raw road-network minutes. */
function legMinutes(mode, rawMinutes) {
  const m = MODES[mode];
  if (rawMinutes === 0) return 0;
  return Math.ceil(rawMinutes * m.factor + m.overheadMinutes);
}

/**
 * Before check-in a renter doesn't have the vehicle yet (it's picked up
 * after check-in), so the morning is planned by cab.
 */
function modeBeforeCheckIn(mode) {
  return mode === "rental" ? "cab" : mode;
}

module.exports = { TRAVEL_MODES, MODES, legMinutes, modeBeforeCheckIn };
