// End-to-end smoke test against a running stack (CI runs it against
// `docker compose up`). Exits non-zero on the first failure.
//
//   node ci/smoke.js [baseUrl]            # checks health, signup/login, metrics
//   node ci/smoke.js [baseUrl] --login    # only checks an existing smoke user can log in
const BASE = process.argv.find((a) => a.startsWith("http")) || "http://localhost:8080";
const LOGIN_ONLY = process.argv.includes("--login");
const USER = { username: "ci_smoke_user", email: "ci_smoke_user@example.com", password: "ci-smoke-password-123" };

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const form = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body),
  redirect: "manual",
});
const sessionCookie = (res) => (res.headers.get("set-cookie") || "").split(";")[0];

async function login() {
  const res = await fetch(`${BASE}/login`, form({ username: USER.username, password: USER.password }));
  const cookie = sessionCookie(res);
  const bookings = await fetch(`${BASE}/bookings`, { headers: { Cookie: cookie }, redirect: "manual" });
  check("existing user can log in (data survived restart)", res.status === 302 && bookings.status === 200, `login ${res.status}, /bookings ${bookings.status}`);
}

(async () => {
  if (LOGIN_ONLY) {
    await login();
  } else {
    const health = await fetch(`${BASE}/healthz`);
    check("GET /healthz", health.status === 200);
    const ready = await fetch(`${BASE}/readyz`);
    check("GET /readyz (MongoDB reachable)", ready.status === 200, JSON.stringify(await ready.json()));
    check("X-Request-Id header", Boolean(health.headers.get("x-request-id")));
    check("security headers", Boolean(health.headers.get("content-security-policy") || (await fetch(`${BASE}/listings`)).headers.get("content-security-policy")));

    const page = await fetch(`${BASE}/listings`, { redirect: "manual" });
    check("GET /listings renders", page.status === 200);
    check("anonymous visit sets no session cookie", !page.headers.get("set-cookie"));

    const signup = await fetch(`${BASE}/signup`, form(USER));
    const cookie = sessionCookie(signup);
    check("signup", signup.status === 302 && signup.headers.get("location") === "/listings", `${signup.status} -> ${signup.headers.get("location")}`);
    const bookings = await fetch(`${BASE}/bookings`, { headers: { Cookie: cookie }, redirect: "manual" });
    check("session works over plain HTTP in the container (HTTPS_ONLY=false)", bookings.status === 200, `/bookings ${bookings.status}`);

    const metrics = await fetch(`${BASE}/metrics`);
    const text = await metrics.text();
    check("GET /metrics", metrics.status === 200 && text.includes("http_request_duration_seconds"));
  }
  if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall smoke checks passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
