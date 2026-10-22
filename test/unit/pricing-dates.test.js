const { test } = require("node:test");
const assert = require("node:assert/strict");
const { quote, formatPaise } = require("../../modules/bookings/pricing.js");
const { parseDay, nightsBetween, validateStay, todayIn, formatDay, DAY_MS } = require("../../modules/bookings/dates.js");

const day = (n) => formatDay(new Date(todayIn().getTime() + n * DAY_MS));

test("quote: fees are charged once per stay on the nightly rate, in paise", () => {
  // The audit's example: 3 nights at ₹1000. The old modal said ₹3,510.
  const q = quote(1000, 3);
  assert.deepEqual(q, {
    currency: "INR",
    nightlyPaise: 100000,
    nights: 3,
    subtotalPaise: 300000,
    cleaningFeePaise: 5000,
    serviceFeePaise: 12000,
    totalPaise: 317000,
  });
  assert.equal(formatPaise(q.totalPaise), "₹3,170");
});

test("quote: totals are integers even for awkward prices", () => {
  const q = quote(1234.56, 7);
  for (const v of Object.values(q)) if (typeof v === "number") assert.ok(Number.isInteger(v));
  assert.equal(q.totalPaise, q.subtotalPaise + q.cleaningFeePaise + q.serviceFeePaise);
});

test("quote: rejects invalid input", () => {
  assert.throws(() => quote(-1, 1));
  assert.throws(() => quote(NaN, 1));
  assert.throws(() => quote(1000, 0));
  assert.throws(() => quote(1000, 1.5));
});

test("parseDay accepts only real calendar days", () => {
  assert.equal(parseDay("2026-08-12").toISOString(), "2026-08-12T00:00:00.000Z");
  for (const bad of ["2026-02-30", "2026-13-01", "12-08-2026", "2026-8-1", "", null, 20260812, "2026-08-12T10:00"]) {
    assert.equal(parseDay(bad), null, String(bad));
  }
});

test("nightsBetween: check-out day is not a night", () => {
  const nights = nightsBetween(parseDay("2026-08-12"), parseDay("2026-08-15")).map(formatDay);
  assert.deepEqual(nights, ["2026-08-12", "2026-08-13", "2026-08-14"]);
});

test("validateStay enforces order, no past check-in, max length and horizon", () => {
  assert.equal(validateStay(day(1), day(4)).nights.length, 3);
  assert.equal(validateStay(day(0), day(1)).nights.length, 1, "today is bookable");

  const bad = [
    [day(3), day(3)], // zero nights
    [day(5), day(2)], // reversed
    [day(-1), day(2)], // past
    [day(1), day(32)], // 31 nights
    [day(400), day(401)], // too far ahead
    ["nope", day(2)],
  ];
  for (const [a, b] of bad) {
    assert.throws(() => validateStay(a, b), (err) => err.statusCode === 400 && err.code === "INVALID_DATES", `${a}..${b}`);
  }
});

test("'today' follows the booking time zone, not UTC", () => {
  // 2026-01-01 20:00 UTC is already 2026-01-02 01:30 in India.
  const now = new Date("2026-01-01T20:00:00Z");
  assert.equal(formatDay(todayIn("Asia/Kolkata", now)), "2026-01-02");
  assert.throws(() => validateStay("2026-01-01", "2026-01-03", { now }), /past/);
});
