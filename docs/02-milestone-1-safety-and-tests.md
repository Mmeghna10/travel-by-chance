# Milestone 1 — Safety fixes & test harness

Goal: close the exploitable holes found in the audit and add an automated test setup, so every later milestone can prove what it claims. Booking logic is unchanged here; that is Milestone 2.

Decisions confirmed: keep EJS, add `units` per listing in M2 (default 1), and admins are created only by a script.

## What changed and why

### 1. `app.js` split into `createApp()` + `server.js` (R-1, R-5)
**Problem:** `app.js` connected to the DB and called `listen()` as soon as it was imported. Tests couldn't load it, and if MongoDB was down the server started anyway and served 500s.
**Design:** `app.js` only *builds* the app. `server.js` loads config, checks the required env vars, waits for MongoDB (10 s timeout), then listens. If something is wrong it exits with an error, so a supervisor (Docker, Render) sees a failed start instead of a half-working server.
**Graceful shutdown:** on SIGTERM/SIGINT it stops accepting connections, lets in-flight requests finish, closes MongoDB, and force-exits after 10 s. This matters once containers are stopped during deploys: requests in progress (later: a payment confirmation) aren't cut off halfway.
**Sessions** now reuse mongoose's connection pool (`client: mongoose.connection.getClient()`) instead of opening a second connection. The broken `store.on("error")` handler that referenced an undefined `err` (R-2) is fixed.

### 2. Health checks — `routes/health.js`
- `GET /healthz`: **liveness**, meaning "the process responds". It deliberately does *not* check the DB: if it did, a DB outage would make the orchestrator restart every instance, which doesn't fix the DB.
- `GET /readyz`: **readiness**, meaning "this instance can serve traffic". It pings MongoDB and returns 503 when unavailable, so a load balancer stops sending traffic here.
They're mounted before sessions, so probes create no session rows.

### 3. Privilege escalation (S-1) — anyone could become admin
**Fix:** `signUp` never reads `role` from the request; it is always `customer`. The "Host / Admin" option was removed from the form. New `npm run create-admin` creates, promotes or lists admins (password from `ADMIN_PASSWORD` so it doesn't land in shell history).
Signup input is now validated with Joi (username charset/length, email, password ≥ 8).
⚠️ **Action for you:** accounts that self-registered as admin *before* this fix are still admins. Run `npm run create-admin -- --list` against your real database and demote any you don't recognise.

### 4. Stored XSS (S-2) and email leak (S-3)
**Problem:** `<%- JSON.stringify(listing) %>` inside `<script>`. `JSON.stringify` doesn't escape `<`, so a review comment containing `</script><script>…` closed the tag and ran attacker JS. The blob also contained populated users, including their **emails**.
**Fix (defence in depth, three layers):**
1. Only send what the map needs: `{ title, geometry }`.
2. Serialise with `utils/safeJson.js`, which escapes `< > &` and U+2028/2029 so the output can't close the tag.
3. `populate()` selects only `username` for owner and review authors.
Also: `map.js` built the popup with `setHTML(title)`, which now uses `textContent`. The Share button put the title into an `onclick` string (HTML entity-decoding turns `&#39;` back into `'`, a JS-injection vector), and it now reads it from the escaped JS variable.

### 5. Security headers, cookies, rate limiting (S-4, S-7)
- `helmet` with a Content-Security-Policy that allowlists exactly the CDNs the views use (jsdelivr, cdnjs, Google Fonts, Mapbox). It also sets `frame-ancestors 'none'` (clickjacking), `object-src 'none'`, `nosniff`, and removes `X-Powered-By`.
  **Trade-off:** `'unsafe-inline'` scripts are still allowed because the templates use many inline `<script>`/`onmouseover` attributes. CSP is therefore a second line of defence here, not the main XSS fix (output escaping is). Moving inline JS into files would allow a strict CSP; that's listed as a limitation.
- Session cookie: renamed `tbc.sid`, `HttpOnly`, `SameSite=Lax` (blocks cross-site form POSTs, the main CSRF vector), `Secure` in production, and `saveUninitialized: false` (no DB write per anonymous visitor).
- `express-rate-limit`: 10 POSTs / 15 min per IP on `/login` + `/signup`, and 20 booking POSTs / min per user. **Limitation:** the counter lives in each process's memory. With several instances behind a load balancer it must move to a shared store (Redis). That is one of the few places Redis is justified, and it's planned for M5/M6.
- JSON and form bodies are capped at 100 kB.

### 6. Query safety (S-5)
User search text is escaped with `utils/escapeRegex.js` and truncated to 100 chars. `?q=(` returned 500 before, and patterns like `(a+)+$` could hang MongoDB (ReDoS). `category` must be a plain string, so `?category[$ne]=x` can't become a Mongo operator (NoSQL injection).

### 7. Bugs
| Finding | Fix |
|---|---|
| F-4 Editing a listing always failed (multipart form, no multer on PUT) | `upload.single('listing[image]')` added to the PUT route; update now uses `listing.set()+save()` (runs schema validators), keeps the old image unless a new one is uploaded, and re-geocodes only when location/country changed |
| S-8 Missing listing/review → `TypeError` → 500 | Explicit 404s; malformed ObjectIds (`CastError`) map to 404 in the error handler |
| — Errors to `fetch()` callers came back as HTML | Error handler returns JSON for `/api/*` and JSON requests; 500 messages are generic (internals are logged, not shown) |
| F-8 All reviews got the server-start timestamp | `default: Date.now` (function, not call) |
| R-6 `logout` continued after an error | `return next(err)` |
| R-3 Hard-coded Google DNS | Opt-in `DNS_SERVERS` env var (your `.env` now sets it, so your Atlas connection behaves as before; Docker will leave it unset) |
| S-9 Noisy logs with user objects | Removed |

### 8. Dependencies (S-6)
`npm audit fix` (non-breaking) brought **23 → 6** advisories. `nodemon` moved to `devDependencies`. Remaining:
- `nodemon → chokidar → braces/minimatch`: dev-only, never runs in production.
- `cloudinary@1` (via `multer-storage-cloudinary@4`, which requires v1): argument injection through parameters containing `&`. We only pass fixed upload params, so it isn't reachable with user input today. Fixing it means replacing `multer-storage-cloudinary` with a small direct upload using `cloudinary@2`, which I'll do in a later milestone.

## Tests

Stack: Node's built-in `node:test` + `supertest` + `mongodb-memory-server`. Each test file starts a **real `mongod`** as a single-node **replica set**, the same topology as Atlas, so Milestone 2's transactions and concurrency tests run against real MongoDB behaviour, not mocks.

```
npm test
```

Actual result (2026-10-21, Windows, Node 22.23.2): **22 tests, 22 passed, 0 failed.**
- `test/auth.test.js`: role injection ignored, weak password rejected, customer blocked from `/admin`, cookie flags, login rate limit returns 429, logout.
- `test/listings.test.js`: XSS payload not rendered raw, no emails in page, security headers, regex/operator injection, 404s instead of 500s, JSON errors for JSON clients, edit form works, non-owner can't edit, review timestamps.
- `test/health.test.js`: liveness, readiness 200 / 503.
- `test/unit/utils.test.js`: `safeJson`, `escapeRegex`.

**Do the tests actually catch the bugs?** I temporarily reverted the role fix and the `safeJson` line: the role-injection and XSS tests both failed, then passed again once the fixes were restored.

**Manual smoke test** in a browser against a throwaway local DB: landing, listings, listing page (Bootstrap, fonts, icons and the Mapbox map all render with no CSP violations in the console), signup, login, `/healthz`, `/readyz`, `?q=(` all OK. The seeded XSS review comment displayed as plain text and `window.pwned` stayed unset.

**Graceful shutdown on SIGTERM:** couldn't be tested on Windows. ✅ **Verified later in CI** (Milestone 7, [run 39595562847](https://github.com/Mmeghna10/travel-by-chance/actions/runs/39595562847)): `docker compose stop app` logged `SIGTERM received, shutting down` → `Shutdown complete` and the container exited with code 0.

## Files
- **New:** `server.js`, `config/env.js`, `routes/health.js`, `middleware/rateLimits.js`, `utils/safeJson.js`, `utils/escapeRegex.js`, `init/create-admin.js`, `test/**`.
- **Changed:** `app.js`, `controllers/{user,listings,review,admin}.js`, `middleware.js`, `schema.js`, `models/review.js`, `routes/listing.js`, `views/listings/show.ejs`, `views/users/signup.ejs`, `public/js/map.js`, `init/{index,migrate_categories}.js`, `package.json`, `package-lock.json`, `.env.example`, `README.md`.

## Commands
```bash
npm install
npm test
npm run dev
```

## Still open (by design, next milestones)
Double booking, payment, idempotency, the price mismatch between the modal and the server (F-7), past-date validation (F-5), and orphaned bookings on listing delete (F-6) are all part of **Milestone 2: correct booking core**.
