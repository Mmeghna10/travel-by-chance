// Turns k6 --summary-export files into a Markdown table (for the CI job summary).
//   node load/k6-report.js browse-summary.json burst-summary.json
const fs = require("fs");

const ms = (v) => (typeof v === "number" ? `${v.toFixed(1)} ms` : "–");

function rows(file) {
  if (!fs.existsSync(file)) return [`| ${file} | not produced (run failed before the end) | | | | |`];
  const { metrics } = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = [];
  for (const [name, m] of Object.entries(metrics)) {
    const match = name.match(/^http_req_duration\{endpoint:(\w+)\}$/);
    if (!match) continue;
    out.push(`| ${file.replace(/-summary\.json$/, "")} | \`${match[1]}\` | ${ms(m.med)} | ${ms(m["p(90)"])} | ${ms(m["p(95)"])} | ${ms(m.max)} |`);
  }
  const reqs = metrics.http_reqs || {};
  const failed = metrics.http_req_failed || {};
  out.push(`| ${file.replace(/-summary\.json$/, "")} | **all requests** | ${reqs.count ?? "–"} requests | ${reqs.rate ? reqs.rate.toFixed(1) + " req/s" : "–"} | errors: ${((failed.value ?? 0) * 100).toFixed(2)} % | |`);
  if (metrics.bookings_created || metrics.bookings_sold_out) {
    const n = (m) => (metrics[m] ? metrics[m].count : 0);
    out.push(`| ${file.replace(/-summary\.json$/, "")} | **bookings: created / sold out / unexpected** | ${n("bookings_created")} | ${n("bookings_sold_out")} | ${n("bookings_unexpected_status")} | |`);
  }
  return out;
}

const lines = ["## k6 results", "", "| Run | Endpoint | p50 | p90 | p95 | max |", "|---|---|---|---|---|---|"];
for (const file of process.argv.slice(2)) lines.push(...rows(file));
console.log(lines.join("\n"));
