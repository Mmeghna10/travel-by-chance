// Wall-clock helpers. The planner works in "minutes after midnight" of the
// arrival day, in the hotel's local time, so no time zone arithmetic happens
// inside the algorithm.
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(hhmm) {
  const m = HHMM.exec(hhmm || "");
  if (!m) throw new Error(`Invalid time "${hhmm}" (expected HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function formatMinutes(total) {
  const m = Math.round(total);
  const h = Math.floor(m / 60) % 24;
  const min = m % 60;
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(min).padStart(2, "0")} ${suffix}`;
}

module.exports = { HHMM, toMinutes, formatMinutes };
