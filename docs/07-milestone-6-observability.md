# Milestone 6: Observability and load testing

Goal: be able to answer "what happened to *this* request?" (logs), "how is the *system* doing?" (metrics), and "how much load does it take, and where does it break?" (load tests). Then use those answers to find and fix real problems, measuring before changing anything.

## 1. Structured logging (`modules/observability/logger.js`)

- **pino**, one JSON object per line: what log platforms (Loki, CloudWatch, Datadog, ELK) index and filter.
- **Request IDs:** every response carries `X-Request-Id`. A well-formed incoming ID (e.g. from a load balancer) is reused, so one ID spans proxy and app logs. Anything else, including log-injection attempts with spaces or newlines and oversized values, is replaced with a fresh UUID.
- **Correlation without passing IDs around:** the ID lives in `AsyncLocalStorage`, and a pino `mixin` stamps it on **every** log line written while handling that request, even deep inside the booking or payment modules. Background job passes get their own ID (`job-refunds-1a2b3c4d`).
- **Access log per request** (pino-http): method, full URL, status, response time, and user id when logged in. Health probes and metric scrapes aren't logged.
- **What's never logged:** headers (cookies, `Authorization`, Razorpay signatures) and request bodies (passwords, payment data) are excluded by the serializers. As a second layer, `redact` blanks `password`, `razorpay_signature`, `keySecret`, `key_secret` and `webhookSecret` anywhere in a logged object.
- **Business events:** `booking created`, `booking transition` (from, to, actor, reason), `payment applied` (source, outcome), `webhook processed`, `refund update`, `refund gave up` (error level: needs a human), `slow MongoDB command`.
- Settings: `LOG_LEVEL` (default `info`), `LOG_PRETTY=true` for human-readable local output (dev only).

Real output from `node server.js` with `NODE_ENV=production` (captured verbatim after the fixes in §3; the first request sent `X-Request-Id: demo-trace-0001`):
```json
{"level":30,"time":"2026-10-21T11:19:50.791Z","service":"travelbychance","req":{"id":"demo-trace-0001","method":"GET","url":"/listings"},"reqId":"demo-trace-0001","res":{"statusCode":200},"responseTime":18,"msg":"GET /listings 200"}
{"level":40,"time":"2026-10-21T11:19:50.799Z","service":"travelbychance","req":{"id":"3186b35a-d877-497f-b945-832c1785d7c4","method":"GET","url":"/listings/not-an-id"},"reqId":"3186b35a-d877-497f-b945-832c1785d7c4","res":{"statusCode":404},"responseTime":3,"msg":"GET /listings/not-an-id 404"}
{"level":30,"time":"2026-10-21T11:19:50.907Z","service":"travelbychance","req":{"id":"d367479b-b43e-4af2-8dc2-0d90ec9e013a","method":"POST","url":"/signup"},"userId":"6ad89fd65a1fba4e61f942fb","reqId":"d367479b-b43e-4af2-8dc2-0d90ec9e013a","res":{"statusCode":302},"responseTime":104,"msg":"POST /signup 302"}
```
And the matching `/metrics` lines:
```
http_request_duration_seconds_count{method="GET",route="/listings",status_code="200"} 1
http_request_duration_seconds_count{method="GET",route="/listings/:id",status_code="404"} 1
http_request_duration_seconds_count{method="POST",route="/signup",status_code="302"} 1
```
(4xx responses log at `warn`, 5xx at `error`.)

## 2. Metrics (`modules/observability/metrics.js`, `GET /metrics`)

Prometheus format via `prom-client`. Labels are kept **low-cardinality**: route *templates* (`/listings/:id`), never raw ids or user ids, and every unmatched URL shares one `unmatched` label. Otherwise each bot probing `/wp-admin/...` would create a new time series.

| Metric | Type | Answers |
|---|---|---|
| `http_request_duration_seconds{method,route,status_code}` | histogram | latency percentiles and error rate per endpoint |
| `booking_attempts_total{outcome}` | counter | created / replayed / sold_out / invalid / error |
| `booking_inventory_conflicts_total` | counter | how often someone loses a night to another guest |
| `booking_transitions_total{from,to,actor}` | counter | expiries, cancellations, late payments, refunds |
| `payment_outcomes_total{source,outcome}` | counter | verify vs webhook vs reconcile: which path confirms payments, and anomalies |
| `webhook_deliveries_total{event,result}` | counter | processed / duplicate / invalid_signature / error |
| `refund_outcomes_total{outcome}` | counter | processed / pending / retry_scheduled / gave_up |
| `background_job_duration_seconds{job,result}` | histogram | expiry / refunds / reconcile duration and failures |
| `mongodb_command_duration_seconds{command}` | histogram | database latency per command type |
| `mongodb_command_failures_total{command,code_name}` | counter | **`WriteConflict` = transaction contention** |
| default `process_*`, `nodejs_*` | various | CPU, memory, GC, **event-loop lag** |

- **Protect it:** set `METRICS_TOKEN` and scrape with `Authorization: Bearer <token>`. Metrics reveal traffic, error rates and internals.
- The **worker** has no Express app, so it serves `/healthz` and `/metrics` on port `9464` (internal; `WORKER_METRICS_PORT`). Compose now health-checks the worker through it.

### Database query monitoring (`modules/observability/db.js`)
The MongoDB driver's command monitoring (`monitorCommands: true`) feeds the histogram above, logs any command slower than `SLOW_QUERY_MS` (default 200 ms) with **command name, collection and duration only, never query values**, and counts failures by error code. Under concurrent bookings for the same night the driver reports `WriteConflict` failures on the losing transactions, which it retries automatically. A test asserts they're counted, which makes contention a number on a dashboard instead of a guess.

### Error tracking hook (`modules/observability/errors.js`)
Every unexpected error (the 5xx path in the Express error handler, job failures, reconciliation errors, session-store errors) goes through `reportError(err, context)`. It logs with the stack trace and request ID, then calls any registered reporters. Plugging in Sentry later is one line at startup: `addErrorReporter((err, ctx) => Sentry.captureException(err, { extra: ctx }))`. Process-level `unhandledRejection` and `uncaughtException` handlers report too; after an uncaught exception the process exits, because its state is unknown, and the platform restarts it.

### Health checks
Unchanged from Milestone 1: `/healthz` = liveness (process responds; never checks dependencies), `/readyz` = readiness (pings MongoDB, 503 when it can't).

## 3. Bugs found by actually reading the output

Tests passed, but looking at real log lines and `/metrics` output showed two more bugs. Both are fixed, and the tests now cover them:
1. **The log message said `GET / 200` for `/listings`.** Inside a router, Express rewrites `req.url` relative to the mount point. Fixed by using `req.originalUrl`.
2. **Metric route labels were wrong:** `/listings/` for the index and `/:id` for a 404 raised inside the listings router. Express resets `req.baseUrl` when a router exits (e.g. after `next(err)`), so it can't be read once the response has finished. Fixed by recording each router's mount path explicitly when it's mounted (`routeBase()`). The test fails with the old logic and lists exactly the bad labels.

## 4. Load testing

### Method
- **`npm run load:baseline`** (`load/baseline.js`): starts the real `node server.js` in `NODE_ENV=production` with JSON logging at `info`, against a throwaway MongoDB replica set. It seeds listings with reviews, signs up real users, and runs:
  - **browse mix:** 20 virtual users for 15 s (50% category pages, 30% detail pages, 20% price quotes), reported per endpoint too;
  - **bookings, spread:** 20 users booking across 30 listings and many dates for 15 s;
  - **bursts:** 200 users at the same instant, on 200 different listings (control), on one listing's **last unit**, and on a 3-unit listing.

  Afterwards it checks **correctness in the database** and reads the server's own `/metrics` (WriteConflicts, CPU, database time per command).
- **k6 scripts** (`load/k6/browse.js`, `load/k6/booking-burst.js`) for running with k6, with thresholds that fail the run on high latency, errors or **any oversold booking**. ⚠️ k6 isn't installed on this machine, so these were only syntax-checked, never run.
- **Rate limits** are per IP, and every virtual user comes from `127.0.0.1`. The load test raises them (`RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_BOOKING_MAX`), otherwise it would only measure the limiter.
- **Machine:** i7-12650H (16 threads), 15.6 GB RAM, Windows 11, Node 22.23.2. Load generator, app and mongod all share this laptop, so these are **local baselines for comparing changes, not production capacity**.

### The first run measured nothing, and that was useful
The first run's booking scenarios produced **zero** bookings, and the correctness checks flagged it. Causes: my harness used `@load.test` emails, which the signup validator rightly rejects; the harness treated any session cookie as a successful signup; and the per-IP rate limiters (correctly) returned 429. Asking *why a failed signup got a session cookie at all* led to the first real finding below.

### Finding 1: every anonymous page view wrote a session to MongoDB
The middleware that copies flash messages into templates called `req.flash()` on every request, and connect-flash's *read* writes `session.flash = {}`. That marks the session modified, so every anonymous visitor got a cookie and a session-store write, silently undoing Milestone 1's `saveUninitialized: false`.

Fix: touch flash only when it holds messages. A test ("anonymous page views don't create sessions") failed before the fix and passes after; the flash-message test still passes.

Same 40-listing dataset, before → after:

| Browse mix, 20 VUs | Before | After |
|---|---|---|
| Throughput | 103.7 req/s | **381.5 req/s (3.7×)** |
| p50 / p95 / p99 | 186.9 / 248.2 / 268.2 ms | **50.0 / 70.2 / 76.8 ms** |
| `GET /listings?category` p95 | 209.9 ms | 56.8 ms |
| `GET /listings/:id` p95 | 263.8 ms | 75.6 ms |
| Session documents after the run | 2,055 | **220** (exactly the logged-in users) |
| Errors | 0 % | 0 % |

### Finding 2: a hypothesis that measurement disproved
Bursts were slow: p50 ≈ 3.5 s for 200 users on the last unit, with ≈ 780 `WriteConflict` retries per run. My hypothesis was that 199 doomed requests were each running a full transaction and colliding. I added an advisory "is any night already full? then fail fast" read before the transaction.

**Result: no change** (p50 3,504 → 3,527 ms; WriteConflicts 790 → 783). In a burst, all 200 requests pass the check before the first one commits. **The change was reverted**: keeping an optimisation the measurements don't support only adds complexity.

### Finding 3: bursts are bound by database throughput, not contention
A control burst where every user books a **different** listing (nothing shared) was *as slow or slower* than the contended bursts:

| Burst of 200 simultaneous bookings | p50 run A | p50 run B |
|---|---|---|
| no contention (200 different listings) | 3,371 ms | 3,875 ms |
| last unit (1 winner, 199 × 409) | 2,082 ms | 2,392 ms |
| 3 units (3 winners) | 2,458 ms | 2,611 ms |

So contention isn't the bottleneck. A burst is 200 transactional bookings queued behind a throughput of roughly 60–90 bookings/s on this machine (spread bookings: 76–90 req/s at 20 VUs; p50 ≈ 217–248 ms, p95 ≈ 265–368 ms). Where the time goes, from the server's own metrics (run B):

| MongoDB command | calls | avg ms |
|---|---|---|
| `find` | 16,760 | 38.0 |
| `update` | 5,322 | 28.6 |
| `insert` | 4,113 | 22.8 |
| `commitTransaction` | 1,358 | 53.7 |

Meanwhile the Node process used only ~64 s of CPU over the ~2-minute run (about half a core). A single-document `find` on local data should take well under 1 ms. An average of 38 ms means **queueing in mongod**, which shares this laptop with the app and the load generator. **The database is the bottleneck, not Node.** So adding Node instances wouldn't help here.

### Correctness under load: every run
- no night ever below 0 or above its units, across 2,232–2,688 listing-nights;
- every night's counter equals the number of confirmed bookings covering it;
- the last-unit burst sold **exactly 1** and the 3-unit burst **exactly 3**: 201 count = units = bookings in the database;
- 0 % server errors in every scenario.

### Run-to-run variance
Two runs of identical code and data differed by 10–15% (browse 200.9 vs 169.6 req/s). Numbers above are reported per run or as ranges, not as one flattering figure.

### What would come next (measure on a real deployment first)
- MongoDB on its own machine (Atlas): removes the queueing measured here.
- Fewer round trips per booking (currently ≈ 10: session, user, idempotency check, listing, counter upserts, then the transaction's inserts/updates and commit), e.g. by caching the listing's price and units briefly.
- Cache rendered browse pages or listing data (Redis or a CDN): the browse path is read-heavy and cacheable. Bookings must never be served from cache.
- Index `listings.category` (noted in the Milestone 1 audit). Category pages currently scan, which is negligible at 240 listings and would matter at 100k.

## 5. Running it yourself
```bash
npm run load:baseline
```
Options: `LOAD_SECONDS`, `LOAD_BROWSE_VUS`, `LOAD_BOOKING_VUS`, `LOAD_BURST`.

With k6 installed (e.g. `winget install k6 --source winget`):
```bash
k6 run -e BASE_URL=http://localhost:8080 load/k6/browse.js
```
```bash
k6 run -e LISTING_ID=<id> -e UNITS=1 -e USERS=200 load/k6/booking-burst.js
```
(For the burst, start the server with `RATE_LIMIT_AUTH_MAX=100000` and `RATE_LIMIT_BOOKING_MAX=100000`.)

## 6. Tests
**114 / 114 passing** (2026-10-21). New in this milestone:
- `test/observability.test.js` (8): request-ID generation, reuse and rejection; structured access-log fields and the full-path message; no session cookie or password in any log line, even when logged explicitly; business log lines carrying the request's ID (async correlation); errors reach the reporter with the request ID and no internals reach the client; route-template labels (including index routes, a 404 raised inside a router, and unmatched URLs); `/metrics` bearer token; booking-outcome, conflict and **WriteConflict** counters under a real 15-user race.
- `test/listings.test.js` (+2): anonymous page views create no session; flash messages still show exactly once.
- Mutation checks: removing redaction fails the password test; removing the request-ID mixin fails the correlation tests; restoring the old route-label logic fails the label test.

## 7. Not verified / limitations
- **k6 scripts not executed** (k6 not installed); only syntax-checked.
- No Prometheus server or Grafana dashboards are set up; `/metrics` is ready to be scraped.
- Load numbers are from one laptop with everything co-located (see §4).
- `booking_transitions_total` counts a transition when it's applied inside a transaction. A transaction attempt that's rolled back and retried by the driver can be counted twice.

## Files
- **New:** `modules/observability/{logger,metrics,db,errors}.js`, `load/baseline.js`, `load/k6/{browse,booking-burst}.js`, `test/observability.test.js`, `docs/07-milestone-6-observability.md`.
- **Changed:** `app.js` (request context, access log, metrics, `/metrics`, error reporting, **flash fix**, router mount labels), `server.js` / `worker.js` (logger, process handlers, DB monitoring, worker metrics server), `config/env.js` (`METRICS_TOKEN`, `RATE_LIMIT_*`), `modules/bookings/{service,stateMachine,lifecycle}.js`, `modules/payments/{service,webhooks,refunds,reconcile}.js`, `modules/jobs/runner.js` (metrics + logs instead of `console`), `compose.yaml` (worker health check), `test/{helpers,listings}.js`, `package.json` (`pino`, `pino-http`, `prom-client`; dev: `pino-pretty`; script `load:baseline`), `.env.example`, `README.md`.
