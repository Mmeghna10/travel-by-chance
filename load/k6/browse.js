// k6 load test: browsing (listing pages, detail pages, price quotes).
//
//   k6 run load/k6/browse.js
//   k6 run -e BASE_URL=http://localhost:8080 -e VUS=50 -e DURATION=1m load/k6/browse.js
//
// Read-only: safe to point at any environment you own. Thresholds make k6
// exit non-zero when the latency/error budget is exceeded (usable in CI).
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:8080";

export const options = {
  scenarios: {
    browse: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 20),
      duration: __ENV.DURATION || "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"], // <1% errors
    "http_req_duration{endpoint:list}": ["p(95)<300"],
    "http_req_duration{endpoint:show}": ["p(95)<300"],
    "http_req_duration{endpoint:quote}": ["p(95)<200"],
  },
};

function isoDay(offset) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + offset * 86400000).toISOString().slice(0, 10);
}

// Runs once: find some listing ids through the public autocomplete API.
export function setup() {
  const ids = new Set();
  for (const q of ["st", "in", "an", "la", "ma"]) {
    const res = http.get(`${BASE}/api/search-suggestions?q=${q}`);
    if (res.status === 200) res.json().forEach((l) => ids.add(l._id));
  }
  if (ids.size === 0) throw new Error("No listings found; seed some first (npm run seed).");
  return { ids: [...ids] };
}

export default function (data) {
  const id = data.ids[Math.floor(Math.random() * data.ids.length)];

  const list = http.get(`${BASE}/listings`, { tags: { endpoint: "list" } });
  check(list, { "list 200": (r) => r.status === 200 });

  const show = http.get(`${BASE}/listings/${id}`, { tags: { endpoint: "show" } });
  check(show, { "show 200": (r) => r.status === 200 });

  const quote = http.get(`${BASE}/api/v1/listings/${id}/quote?checkIn=${isoDay(30)}&checkOut=${isoDay(33)}`, {
    tags: { endpoint: "quote" },
  });
  check(quote, { "quote 200": (r) => r.status === 200 });

  sleep(1); // think time between page views
}
