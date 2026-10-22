const { test } = require("node:test");
const assert = require("node:assert/strict");
const { TRANSITIONS, canTransition, inventoryEffect } = require("../../modules/bookings/stateMachine.js");
const { BOOKING_STATUSES } = require("../../models/booking.js");

const ACTORS = ["guest", "system", "payment"];

// The table as the single expected truth: [from, to, actor].
const ALLOWED = [
  ["PENDING_PAYMENT", "CONFIRMED", "payment"],
  ["PENDING_PAYMENT", "EXPIRED", "system"],
  ["PENDING_PAYMENT", "CANCELLED", "guest"],
  ["CONFIRMED", "CANCELLED", "guest"],
  ["CONFIRMED", "REFUND_PENDING", "guest"],
  ["EXPIRED", "CONFIRMED", "payment"],
  ["EXPIRED", "REFUND_PENDING", "payment"],
  ["CANCELLED", "REFUND_PENDING", "payment"],
  ["REFUND_PENDING", "REFUNDED", "payment"],
  ["REFUND_PENDING", "REFUND_FAILED", "payment"],
];

test("every status in the model appears in the transition table", () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...BOOKING_STATUSES].sort());
});

test("exactly the documented transitions are allowed, for exactly the documented actor", () => {
  const allowed = new Set(ALLOWED.map((t) => t.join(">")));
  let checked = 0;
  for (const from of BOOKING_STATUSES) {
    for (const to of BOOKING_STATUSES) {
      for (const actor of ACTORS) {
        const expected = allowed.has([from, to, actor].join(">"));
        assert.equal(canTransition(from, to, actor), expected, `${from} -> ${to} by ${actor}`);
        checked++;
      }
    }
  }
  assert.equal(checked, 7 * 7 * 3);
});

test("notable invalid transitions are rejected", () => {
  assert.equal(canTransition("REFUNDED", "CONFIRMED", "payment"), false, "terminal");
  assert.equal(canTransition("CONFIRMED", "PENDING_PAYMENT", "payment"), false, "no going back");
  assert.equal(canTransition("CONFIRMED", "EXPIRED", "system"), false, "expiry must never touch a confirmed booking");
  assert.equal(canTransition("EXPIRED", "CANCELLED", "guest"), false, "nothing left to cancel");
  assert.equal(canTransition("PENDING_PAYMENT", "CONFIRMED", "guest"), false, "a guest can't confirm without paying");
  assert.equal(canTransition(undefined, "CANCELLED", "guest"), false, "legacy bookings without status");
});

test("inventory effects: release when leaving a holding state, reserve when entering one", () => {
  assert.equal(inventoryEffect("PENDING_PAYMENT", "CONFIRMED"), "none");
  assert.equal(inventoryEffect("PENDING_PAYMENT", "EXPIRED"), "release");
  assert.equal(inventoryEffect("PENDING_PAYMENT", "CANCELLED"), "release");
  assert.equal(inventoryEffect("CONFIRMED", "CANCELLED"), "release");
  assert.equal(inventoryEffect("CONFIRMED", "REFUND_PENDING"), "release");
  assert.equal(inventoryEffect("EXPIRED", "CONFIRMED"), "reserve");
  assert.equal(inventoryEffect("EXPIRED", "REFUND_PENDING"), "none");
  assert.equal(inventoryEffect("CANCELLED", "REFUND_PENDING"), "none");
  assert.equal(inventoryEffect("REFUND_PENDING", "REFUNDED"), "none");
});
