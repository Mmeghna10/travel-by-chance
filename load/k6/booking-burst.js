// k6 load test: many users try to book the same night at the same moment.
//
//   k6 run -e LISTING_ID=<id> -e UNITS=1 -e USERS=200 load/k6/booking-burst.js
//
// Writes data (creates users and bookings): use a local/test environment
// only. All virtual users come from one IP, so start the server with raised
// rate limits, e.g. RATE_LIMIT_AUTH_MAX=100000 RATE_LIMIT_BOOKING_MAX=100000
// (otherwise you're load-testing the rate limiter).
//
// Correctness is part of the test: the run FAILS if more bookings succeed
// than the listing has units (threshold on bookings_created).
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE = __ENV.BASE_URL || "http://localhost:8080";
const USERS = Number(__ENV.USERS || 200);
const UNITS = Number(__ENV.UNITS || 1);
const LISTING_ID = __ENV.LISTING_ID;
const CHECK_IN = __ENV.CHECK_IN || isoDay(200);
const CHECK_OUT = __ENV.CHECK_OUT || isoDay(201);

const bookingsCreated = new Counter("bookings_created");
const soldOut = new Counter("bookings_sold_out");
const unexpected = new Counter("bookings_unexpected_status");

// 201 and 409 (sold out) are both correct answers here, not failures.
http.setResponseCallback(http.expectedStatuses(200, 201, 302, 409));

export const options = {
  setupTimeout: "5m",
  scenarios: {
    burst: {
      // One iteration per VU, all starting together: a burst.
      executor: "per-vu-iterations",
      vus: USERS,
      iterations: 1,
      maxDuration: "2m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    bookings_created: [`count<=${UNITS}`], // never oversell
    // Every other user must have COMPETED and been told "sold out". Without
    // this, a broken setup (e.g. users not logged in) passes the oversell
    // check trivially, which is exactly what the first CI run did.
    bookings_sold_out: [`count==${USERS - UNITS}`],
    bookings_unexpected_status: ["count==0"],
    "http_req_duration{endpoint:book}": ["p(95)<5000"],
  },
};

function isoDay(offset) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + offset * 86400000).toISOString().slice(0, 10);
}

// Sign up one user per VU before the burst (not measured as part of it).
export function setup() {
  if (!LISTING_ID) throw new Error("Set -e LISTING_ID=<a listing id> (and -e UNITS=<its units>)");
  const run = uuidv4().slice(0, 8);
  const cookies = [];
  for (let i = 0; i < USERS; i++) {
    const username = `k6_${run}_${i}`;
    const res = http.post(
      `${BASE}/signup`,
      { username, email: `${username}@example.com`, password: "k6-load-test-pass" },
      { redirects: 0 },
    );
    const sid = res.cookies["tbc.sid"];
    if (res.status !== 302 || !sid) throw new Error(`signup ${i} failed: ${res.status}`);
    cookies.push(sid[0].value);
    // Forget this user before signing up the next one. Otherwise the next
    // signup sends this cookie, logging in replaces that session, and every
    // user but the last ends up logged out.
    http.cookieJar().clear(BASE);
  }
  return { cookies };
}

export default function (data) {
  const res = http.post(
    `${BASE}/api/v1/bookings`,
    JSON.stringify({ listingId: LISTING_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT }),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": uuidv4(),
        Cookie: `tbc.sid=${data.cookies[__VU - 1]}`,
      },
      tags: { endpoint: "book" },
    },
  );
  check(res, { "201 or 409": (r) => r.status === 201 || r.status === 409 });
  if (res.status === 201) bookingsCreated.add(1);
  else if (res.status === 409) soldOut.add(1);
  else {
    unexpected.add(1);
    console.warn(`VU ${__VU}: unexpected ${res.status} ${String(res.body).slice(0, 120)}`);
  }
}
