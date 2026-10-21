# Interview preparation: explaining TravelByChance

Everything here describes what is **actually in the code and was actually measured**. Each answer has a short version (about 30 s), a deeper version with file pointers, and likely follow-ups. Where something was *not* done, it says so: interviewers respect "I measured X and haven't done Y" far more than vague claims.

---

## 1. The 2-minute project pitch

> "TravelByChance started as a CRUD travel-listings site I'd built with Express, EJS and MongoDB. I audited it and found it could double-book the same room: the booking endpoint never checked availability. Anyone could also make themselves an admin, and there was a stored XSS. So I rebuilt the backend around the hard parts of a booking system, in milestones.
>
> First, correctness under concurrency. Inventory is modelled per listing-night. A booking reserves each night with an **atomic conditional update inside a MongoDB transaction**, and an **idempotency key** makes retries safe. In my tests 100 users racing for the last room get exactly one booking and 99 'sold out'. The naive check-then-insert version sold the room 4 and 40 times in two runs.
>
> Then an explicit **booking state machine** with holds that expire, and **Razorpay payments**. A booking is only confirmed on a server-verified, captured payment. Duplicate and out-of-order webhooks are harmless. Refunds go through a **transactional outbox**, and a reconciliation job recovers payments we never heard about.
>
> Finally the operational side: Docker, structured logs with request IDs, Prometheus metrics, load testing, which found a bug that made browsing 3.7× faster once fixed, and a GitHub Actions pipeline that tests the real containers, including graceful shutdown, on every push. It's 114 tests against a real MongoDB replica set."

**30-second version:** "A travel booking backend where I focused on correctness: no double booking under concurrency (atomic updates plus transactions, proven with 100-user races), idempotent APIs, a booking state machine, and Razorpay payments that are only confirmed on server-verified captures, with webhooks, refunds and reconciliation. All of it is tested, containerised, observable and run through CI."

---

## 2. The core questions

### Q1. How did you prevent double booking?

**Short:** "I made each listing-night a counter document, and booking a night is one atomic conditional update: *increment `reserved` only if it's still below `units`*. MongoDB applies the check and the increment to that one document atomically, so the last unit can only be taken once. A transaction wraps all the nights plus the booking insert, so a multi-night stay is all-or-nothing."

**Deeper:**
- What's sold is a **listing-night**, not a "booking". A stay from 12 to 15 Aug uses three nights, and the check-out day is free. That turns "find overlapping bookings" (many documents, nothing for the database to detect a conflict on) into "contend on the same document" (`InventoryNight`, unique index on `(listing, date)`).
- `modules/bookings/inventory.js → reserveNights()`:
  `updateOne({ listing, date, reserved: { $lt: units } }, { $inc: { reserved: 1 } })`. If `modifiedCount` is 0, the night is full and I throw `SOLD_OUT`.
- `modules/bookings/service.js`: one transaction does three things: claim the idempotency key, reserve each night in date order, insert the booking. Any failure rolls all three back.
- Counters are created *outside* the transaction (`ensureNights`, an upsert with `$setOnInsert`), so "night doesn't exist yet" can't be confused with "night is full".

**Evidence:** `test/concurrency.test.js` (100 users / 1 unit → 1 × 201 + 99 × 409; 60 users / 5 units → exactly 5). After every scenario the test checks the database: `0 ≤ reserved ≤ units`, and each counter equals the number of bookings covering that night.

**Follow-ups:**
- *"Why not just check for overlapping bookings first?"* That's check-then-act: two requests both read "free" before either writes. I measured it: without a transaction it sold one room 4 and 40 times.
- *"What isolation level does that rely on?"* MongoDB transactions use snapshot isolation. When two transactions write the same document, the second gets a `WriteConflict` and the driver retries it. Interestingly, I found that even naive check-then-act *inside* a transaction didn't oversell, because of that conflict detection. I kept the conditional update anyway because it's correct on its own (it also passed with the transaction removed), and it's clearer.
- *"What about hotel rooms with many units?"* `Listing.units` handles that: a 6-bed dorm has `units: 6`, and the same update allows exactly 6.

### Q2. What happens when 100 users try to book the last seat at the same moment?

**Short:** "All 100 transactions try to increment the same night document. One commits. The others hit a `WriteConflict` and are retried by the driver, and on retry the condition `reserved < units` is false, so they get `409 SOLD_OUT`. Result: exactly one booking, 99 clean 'sold out' responses, no negative inventory."

**Deeper:** The cost of that safety is retries. In load tests, about 780 `WriteConflict` errors were counted per run (the app exports `mongodb_command_failures_total{code_name="WriteConflict"}` from driver command monitoring). Latency for a 200-user burst was 2–4 s on my laptop. I then ran a **control**: 200 users booking 200 *different* listings (no contention at all). It was just as slow, so the bottleneck wasn't contention but database throughput on a single machine (≈ 60–90 transactional bookings/s). I'd only optimise contention after seeing it dominate on real infrastructure.

**Follow-up, "Could you make the losers fail faster?"** I tried: an advisory "is the night already full?" read before the transaction. It made **no measurable difference**, because in a burst all 200 requests pass the check before the first commit. So I reverted it. Keeping an optimisation the numbers don't support just adds complexity.

### Q3. Why is a database transaction necessary? Isn't the atomic update enough?

**Short:** "The atomic update protects *one* night. A booking touches several documents: N nights, the booking, the idempotency record, and for refunds an outbox row. The transaction makes them commit or fail together."

**Deeper, with evidence from mutation testing:**
- Without the transaction, the test *"multi-night stay is all-or-nothing"* fails: if night 3 is full, nights 1–2 stay incremented, which leaks inventory.
- *"A failure after inventory was reserved rolls everything back"*: I stub `Booking.create` to throw; with the transaction, counters, the idempotency key and the booking all disappear.
- Cancellation and expiry release nights in the same transaction as the status change. In a test where the crash happens **between releasing night 1 and night 2**, the transaction rolls back night 1's release too. Moving the release outside the transaction makes that test fail (inventory drift).

**What a transaction does *not* do:** it doesn't make a check-then-act in application code safe by itself in every database, it doesn't prevent duplicate requests (that's idempotency), and it can't include external calls like Razorpay (that's why refunds use an outbox).

**MongoDB detail:** multi-document transactions need a **replica set**, so the Docker setup runs a single-node replica set and the tests use `MongoMemoryReplSet`. Unique indexes are created explicitly at startup (`ensureIndexes()`), because the idempotency guarantee doesn't exist until its index does.

### Q4. How do you stop a double click or a retry from creating two bookings?

**Short:** "The browser generates an `Idempotency-Key` when the confirm dialog opens and reuses it for retries. The server claims the key in the same transaction as the booking, with a unique index on (user, scope, key). A repeat returns the stored response; the same key with a different payload returns 422."

**Detail:** The key is written **first** in the transaction. If it were written last, a duplicate could fail with "sold out" (its twin took the room) before reaching the key check, and the user would see an error for a booking that actually succeeded. Test: 20 identical requests at once → 20 × 201, one booking id, and only one unit consumed even though 3 were available.

### Q5. What if the payment succeeds but the backend crashes?

**Short:** "Nothing is lost, because three independent paths can confirm a payment, and they all funnel into one idempotent function: the browser's verify call, Razorpay's webhook, and a reconciliation job that asks Razorpay directly. Whichever arrives first does the work; the rest are no-ops."

**Deeper:**
- `modules/payments/service.js → applyGatewayPayment()` validates the payment (order id, amount, currency), marks it `CAPTURED` with a status-rank guard, and **always** calls `confirmPayment()`, even if the payment was already captured. So a crash *between* "payment recorded" and "booking confirmed" is finished by the next attempt. `confirmPayment()` itself is idempotent.
- `modules/payments/reconcile.js` (every 30 s): orders quiet for more than 1 minute → `orders.fetchPayments`. It also finds payments captured on our side whose booking never got confirmed. It looks back 4 days, because Razorpay auto-refunds *uncaptured* payments after 3.
- **Late payment policy:** if the hold already expired, re-reserve the nights if they're still free (`CONFIRMED_LATE`); otherwise `REFUND_PENDING` and queue a refund. Money is never dropped silently, and inventory is never oversold to honour it.

**Evidence:** tests *"reconciliation confirms a payment nobody told us about"* and *"…finishes a crash between 'payment captured' and 'booking confirmed'"*.

**Honest caveat:** this is tested against a Razorpay simulator with real HMAC signatures. A live sandbox payment hasn't been run, because onboarding required KYC.

### Q6. Why are webhooks necessary if the browser already reports success?

**Short:** "Because the browser is untrusted and unreliable. A user can fake a 'success' callback, close the tab, or lose network right after paying. The webhook is Razorpay telling *our server* directly, signed with a secret. And I never trust the browser anyway: even its callback is verified (HMAC over **our** stored order id) and then confirmed by fetching the payment from Razorpay's API, which must be `captured` with the right amount."

**Follow-ups:**
- *"Why fetch from the API if the signature is valid?"* The signature proves Razorpay issued that payment id for our order. It doesn't tell me the payment is *captured*, or for the right amount. A test pays ₹1 instead of ₹2,170 with a valid signature, and the booking is not confirmed.
- *"Why must webhook verification use the raw body?"* The HMAC is over the exact bytes. Parsing and re-serialising JSON can change whitespace or key order. The route is mounted with `express.raw()` before `express.json()`. A test shows a pretty-printed copy of a genuine body fails verification. I also hit this for real: supertest JSON-encoded a Buffer, and my server (correctly) rejected it.
- *"Timing attacks?"* The official SDK helpers compare with `===`. I use `crypto.timingSafeEqual`, and a test checks I agree with the SDK on 1,000 valid and tampered inputs.

### Q7. How do you make webhook processing idempotent?

**Short:** "Two layers. Each delivery's `x-razorpay-event-id` is recorded with a unique index, and already-processed events are acknowledged without work. But correctness doesn't depend on that log: every handler is idempotent on its own, and payment statuses have ranks that never move backwards."

**Deeper:**
- Delivery is at-least-once and unordered, so the same event can arrive twice, even **concurrently**, and `payment.authorized` can arrive after `payment.captured`.
- Payment ranks: `CREATED/FAILED (1) < AUTHORIZED (2) < CAPTURED (3)`. Updates are guarded (`status: { $in: lowerRanks }`), so a late `failed` or `authorized` can't overwrite `captured`.
- Booking side: `confirmPayment()` returns `ALREADY_CONFIRMED` on repeats. Refund side: `REFUNDED` only once.
- If processing throws, the event is marked `FAILED` and I return 5xx so Razorpay retries.

**Evidence:** 10 concurrent deliveries of the same event → one `CONFIRMED` transition in the audit trail; a test delivers captured → old failed → stale authorized and still ends `CAPTURED`/`CONFIRMED`.

### Q8. Why not keep the inventory only in Redis?

**Short:** "Because the inventory and the bookings must change together, atomically and durably. If the counter is in Redis and the booking in MongoDB, there's no transaction across them: a crash between the two leaves a decremented counter with no booking, or a booking with no decrement. Redis persistence is also asynchronous by default, so an acknowledged write can be lost on failover. For rooms and money, the source of truth has to be the database that holds the bookings."

**Where Redis *would* fit here:** a shared rate-limit store once there are several web instances (today's limiter is per process), caching read-heavy listing pages, or a pre-check gate in front of the database. But never as the authority on whether a room is booked.

### Q9. When would you use distributed locks?

**Short:** "Only when two processes must not perform the same **external side effect** concurrently and the database can't serialise it for me. I needed exactly that once: submitting refunds to Razorpay."

**The real example (`modules/payments/refunds.js`):** A refund is an HTTP call to Razorpay. It can't be inside a MongoDB transaction, and "check if a refund exists, then create one" is a check-then-act race *against Razorpay*. So a worker **claims** the refund row atomically (`REQUESTED → SUBMITTING`) with a **lease**: a lock with an expiry (`lockedUntil`, 2 min), implemented with `findOneAndUpdate` in MongoDB. If the worker dies, the lease expires and another worker retries. Because a lease can expire while its holder is still running (the classic distributed-lock problem), there's a second safety net: before creating a refund, the worker searches Razorpay for an existing refund with our receipt (`rf_<bookingId>`) and adopts it.

**Evidence that both are needed:** mutation testing. Without the receipt lookup, a "response lost after Razorpay refunded" test refunds twice. Without the lease, three concurrent workers created duplicate refunds, but only once I gave the simulator realistic 40 ms API latency. With instant responses the race was hidden.

**When I would *not* use one:** for inventory. The database already serialises writes to the same document, and a lock in Redis (Redlock) can expire mid-operation, which would add a second source of truth that can disagree with the first.

### Q10. Why a modular monolith instead of microservices?

**Short:** "My key correctness tool is one transaction spanning the booking, its nights, the idempotency record and the refund outbox. Split into booking, inventory and payment services, that becomes a distributed saga with compensating actions and eventual consistency: more failure modes, for a team of one and a single database. So it's one codebase with clear modules (`modules/bookings`, `modules/payments`, `modules/observability`), deployed as two processes from the same image: web and worker."

**When I'd split:** when there's a reason the monolith can't satisfy, such as independent scaling with a very different load profile, separate teams owning separate deploy cycles, or compliance isolation (payments are the most likely first candidate). The module boundaries and the outbox pattern make that split possible later.

### Q11. How would this scale to a million users?

**Short:** "First, translate a million *users* into load. Even optimistic numbers mean a few hundred requests per second at peak, mostly browsing. Then scale based on what I measured: the database saturated first, not Node. So: managed MongoDB on dedicated hardware, cache the read-heavy pages, fewer database round trips per booking, then horizontal web instances, with a shared rate-limit store."

**Step by step:**
1. **Measure on real infrastructure.** My load numbers are from one laptop (app, database and load generator together; `find` averaged ~38 ms because of queueing, while Node used about half a core).
2. **Database:** MongoDB Atlas on dedicated tiers. Indexes exist for every hot query (inventory and idempotency uniques, `bookings(user, createdAt)`, `(status, expiresAt)`); `listings.category` still needs one. Browse queries can read from secondaries (slightly stale is fine). **Booking writes always go to the primary.**
3. **Caching:** listing pages and search are read-heavy and cacheable (Redis or a CDN). Availability shown on the page is already treated as advisory; only the booking transaction decides.
4. **App tier:** web instances are stateless (sessions in the database), so add instances behind the load balancer. Move the rate limiter to Redis.
5. **Fewer round trips per booking:** today about 10 (session, user, idempotency check, listing, counter upserts, then the transaction). Cache listing price and units briefly; consider JWT or a Redis session store to cut session reads.
6. **Hotspots:** one very popular night is one document, so contention on it is inherent. That's correct behaviour (someone has to lose). For very high demand, add a queue or waiting room in front of the booking API rather than weakening the guarantee.
7. **Sharding** (much later): shard inventory and bookings by `listing`, so each booking transaction stays on one shard.
8. **Background jobs** already tolerate parallel workers (guarded transitions, leases), so they scale by adding workers.

### Q12. How would you debug a slow booking API?

**Short:** "Start from data, not guesses. Metrics tell me *whether* and *where* it's slow, logs tell me *which* requests, and the database metrics tell me *why*. Then reproduce it with the load harness, change one thing, and measure again."

**With the tools in this project:**
1. `http_request_duration_seconds{route="/api/v1/bookings"}`: p50/p95/p99, and when it started.
2. Is it the database? `mongodb_command_duration_seconds` by command, `mongodb_command_failures_total{code_name="WriteConflict"}` for contention, and slow-command logs (`SLOW_QUERY_MS`, which log command, collection and duration, never values).
3. Is it Node? `nodejs_eventloop_lag_seconds` and process CPU.
4. Take a slow request's `X-Request-Id` and follow every log line it produced (the request ID is propagated with `AsyncLocalStorage`).
5. Reproduce with `npm run load:baseline`. It checks correctness too, so an optimisation can't quietly break bookings.

**A real story from this project:** the load test showed 2–4 s bursts and ~780 write conflicts, so contention looked like the culprit. My fail-fast fix changed nothing, and a no-contention control was equally slow. The database metrics showed `find` averaging 38 ms (queueing) with Node mostly idle: the database was the bottleneck. The same investigation found a real bug: every anonymous page view wrote a session to MongoDB because of how flash messages were read. Fixing it took browse throughput from **103.7 to 381.5 req/s** (p95 248 → 70 ms).

---

## 3. Stories for "tell me about a bug / a time you were wrong"

**The session-per-page-view bug (found by a broken load test).** My first load run produced zero bookings. Two causes were mine: my test emails used a `.test` domain the validator rejects, and my harness treated any cookie as a successful signup. But *why did a failed signup get a session cookie?* Because the flash-message middleware read `req.flash()` on every request, and that read writes `session.flash = {}`, so every anonymous visitor got a session written to MongoDB. I wrote a failing test, fixed it, and measured 3.7× more browse throughput. **Lesson:** when the numbers look wrong, ask why before tuning.

**Tests that passed for the wrong reason (mutation testing).** I removed safeguards on purpose to see if tests caught it. Several didn't at first: a crash test injected the failure before anything was released; a race test always ran in the same order (cancel won 15/15 until I added random jitter); a refund race only appeared with simulated network latency. **Lesson:** a passing concurrency test proves little unless you've seen it fail without the fix.

**An intermittent CI failure I misdiagnosed first.** The Docker job failed starting the Compose stack after about 12 s, and I couldn't read the logs (GitHub hides them unless you're signed in). Reviewing the setup, I found a real bug (the MongoDB health check reported healthy before a primary existed), fixed it, and the next run was green. So I believed that was the cause. Two runs later it failed again. Because I'd made CI publish container diagnostics as public annotations, I could finally see the real cause: *"MongoDB cannot start: Linux kernel versions 6.19 and newer has a known incompatibility"*. GitHub's runners have mixed kernels, so the green run had just landed on an older machine. I then tried `mongo:8.3.13`, assuming newer meant fixed; it refused too. I switched to MongoDB 7.0, outside the affected range, ran the full suite against 7.0 locally (114/114), and made CI record the runner's kernel. The final green run was **on the same kernel that broke 8.x**, which is what makes it proof. **Lessons:** one green run doesn't prove a fix for an intermittent failure, and make failures observable before guessing.

**A wrong optimisation I removed.** The fail-fast sold-out check (Q2). Measured, no effect, reverted.

---

## 4. Resume bullets (all verifiable in the repo)

- Re-architected a Node.js/Express/MongoDB travel booking platform to prevent double booking with per-night inventory, atomic conditional updates and multi-document transactions. 100 concurrent requests for the last unit yield exactly one booking (the naive approach oversold 4–40×).
- Built idempotent booking APIs (idempotency keys + unique index inside the transaction) and an explicit booking state machine with guarded, audited transitions, hold expiry and cancellation.
- Integrated Razorpay (test mode): server-side signature + API verification, raw-body webhook verification, duplicate/out-of-order event handling, a transactional-outbox refund worker with leases, retries and dead-lettering, and a reconciliation job for crash recovery.
- Added observability (pino JSON logs with request IDs, Prometheus metrics, MongoDB command monitoring); load testing found a per-request session write, and fixing it raised browse throughput 3.7× (p95 248 → 70 ms).
- Containerised with Docker/Compose and built a GitHub Actions pipeline (lint, 114 tests on a real MongoDB replica set, Docker smoke test including graceful shutdown and persistence, image scanning, SHA-pinned actions, deploy-by-digest).

## 5. Things to be careful not to over-claim

| Don't say | Say instead |
|---|---|
| "It's deployed / in production" | "CI publishes and can deploy; I've written the deployment plan, but no production environment exists yet" |
| "Payments are fully tested with Razorpay" | "Tested against a simulator using real HMAC signatures; Checkout verified in the browser; a live sandbox payment is pending (KYC)" |
| "It handles X thousand bookings per second" | "On one laptop, about 60–90 transactional bookings/s; the database was the bottleneck; production numbers need real infrastructure" |
| "I load-tested with k6" | "I wrote k6 scripts with correctness thresholds; the baseline was measured with my Node harness" |
| "Microservices architecture" | "Modular monolith, on purpose (Q10)" |

## 6. Quick-reference: where things are

| Topic | File |
|---|---|
| Inventory and the atomic update | `modules/bookings/inventory.js` |
| Booking transaction and idempotency | `modules/bookings/service.js`, `models/idempotencyRecord.js` |
| State machine | `modules/bookings/stateMachine.js` |
| Confirm, cancel, expiry | `modules/bookings/lifecycle.js` |
| Payments, webhooks, refunds, reconciliation | `modules/payments/*.js` |
| Signatures (constant-time) | `modules/payments/signatures.js` |
| Logs, metrics, DB monitoring | `modules/observability/*.js` |
| Concurrency tests | `test/concurrency.test.js`, `test/lifecycleRaces.test.js` |
| Razorpay simulator | `test/fakeRazorpay.js` |
| Load harness | `load/baseline.js` |
| CI | `.github/workflows/ci.yml`, `ci/smoke.js` |
