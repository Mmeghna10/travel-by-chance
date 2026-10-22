# 10. Redis and going live

Two upgrades after Milestone 8:

1. **Redis**, where it has a concrete job: shared rate-limit counters and a listing cache.
2. **Live-payment readiness**: the pages and safeguards a real site needs before Razorpay will activate live payments.

---

## Part A: Redis

### A1. What Redis does here, and what it deliberately doesn't

| Data | Where it lives | Why |
|---|---|---|
| Bookings, inventory, payments, refunds, idempotency records | **MongoDB** | Must survive crashes and be updated in the same transaction. A cache can never be the source of truth for rooms or money. |
| Sessions | **MongoDB** (`connect-mongo`) | Already shared by every instance and durable. Moving them to Redis would log everyone out whenever Redis restarts, for little gain. |
| Background jobs | **MongoDB rows** (leases, retries, dead-letter) | Already durable and transactional with the booking (outbox). BullMQ would add a second queue to keep consistent. |
| **Rate-limit counters** | **Redis** | Per-process counters mean "10 login attempts" becomes 10 × the number of instances. One shared counter makes the limit real. |
| **Listing cache** (browse, landing, search suggestions) | **Redis** | The read-heavy, rarely-changing pages. The search box fires on every keystroke. |

Everything in Redis is safe to lose. That's why persistence is off (`--save "" --appendonly no`) and why the app treats Redis as **optional**.

### A2. Failing safe

| Situation | Rate limits | Listing pages | `/readyz` |
|---|---|---|---|
| `REDIS_URL` unset (e.g. `npm run dev`) | Per-process memory | Read MongoDB directly | 200, `redis: "off"` |
| Redis up | Shared in Redis | Cached (60 s TTL) | 200, `redis: "ok"` |
| Redis goes down mid-flight | Fall back to memory, **never off** | Fall back to MongoDB | 200, `redis: "down"` |
| Redis hangs (connected but slow) | Each call times out after 200 ms, then memory | Same, then MongoDB | 200 |

The rate limiter's two bad alternatives are why the fallback store exists ([`middleware/rateLimitStore.js`](../middleware/rateLimitStore.js)):

- **Fail closed** (reject when Redis is down): nobody can log in or book during a cache outage.
- **Fail open** (skip limits): brute-force protection disappears exactly when something is already wrong.

Falling back to per-process counting keeps a looser limit in place until Redis returns. The client uses `disableOfflineQueue`, so commands fail immediately while disconnected instead of queueing (a queued check would hold the request until Redis came back). It reconnects in the background with backoff, and the store reloads its Lua scripts when Redis returns.

Readiness doesn't fail on Redis: without it the app is slower, not broken. Failing readiness would let a cache outage take the whole site offline.

### A3. The listing cache: cache-aside with generation keys

[`modules/cache/listingCache.js`](../modules/cache/listingCache.js):

```
read:  gen = GET tbc:listings:gen
       key = tbc:listings:{gen}:{browse|featured|suggest}:{sha1(params)}
       hit  -> return it
       miss -> load from MongoDB, SET key EX 60 (in the background), return it
write: any listing write -> INCR tbc:listings:gen
```

**Why a generation number instead of deleting keys?** One listing appears in many cached results (all stays, its category, many search terms). Finding and deleting all of them is error-prone. Bumping the generation makes every old key unreachable at once, and they expire on their own.

**Where invalidation happens:** Mongoose hooks on the `Listing` model (`save`, `findOneAndUpdate`, `findOneAndDelete`, `updateOne/Many`, `deleteOne/Many`, `insertMany`). Adding or deleting a review changes `listing.reviews`, so it goes through those hooks too. Putting this in the model rather than in each controller means no write path can forget it.

**Race check.** A reader reads generation 5 and loads from MongoDB *before* a write commits. The writer commits and bumps to 6. The reader then stores old data under a generation-5 key, which nobody reads any more. The only stale window is between the MongoDB commit and the `INCR`: a few milliseconds.

**Staleness bound.** If Redis is unreachable at the moment of a write, the bump is lost. Entries cached before the outage are served for at most the 60 s TTL once Redis is back. That is acceptable for display data.

**What can't go wrong:** the cache holds display data only. Prices at booking time come from `modules/bookings/pricing.js` and MongoDB, and availability from the inventory collection, never from this cache. A stale card can show an old price; it can't sell a room at that price.

**Memory policy:** `maxmemory 64mb` with `volatile-lru`. Under pressure Redis evicts least-recently-used keys *that have a TTL* (cache entries and rate-limit counters). The generation key has no TTL, so it is never evicted. Evicting it would reset generations to 0 and could make an old generation's keys reachable again.

### A4. Observability

| Metric | Meaning |
|---|---|
| `cache_requests_total{cache, result}` | `hit` / `miss` / `error` / `bypass` (Redis unavailable) per cache |
| `redis_errors_total` | Client errors (drops, failed reconnects) |
| `rate_limit_store_fallbacks_total{limiter}` | Rate-limit checks counted in memory because Redis was unavailable |

Logs: one warning per 30 s while Redis is unreachable (not one per failed reconnect), and `redis connected` when it returns.

### A5. Tests

| File | Runs where | What it proves |
|---|---|---|
| [`test/redisFallback.test.js`](../test/redisFallback.test.js) (8) | Everywhere (in-memory stand-in for Redis) | Second read is a cache hit; saving a listing or adding a review invalidates every cached page; search suggestions are cached per query; a **broken** Redis never breaks a page; a **disconnected** Redis is bypassed and writes still succeed; rate limits still work in memory when Redis can't count; readiness reports Redis but doesn't depend on it |
| [`test/redis.integration.test.js`](../test/redis.integration.test.js) (3) | CI (real Redis service), or locally with `TEST_REDIS_URL` | **Two app instances share one limit** (3 attempts in total, not 3 each; one counter key with a TTL); a real cache round trip with TTL and invalidation; readiness shows `redis: "ok"` |

"Hit or miss" is proven without spying on internals. The test changes a title **directly in the collection** (no Mongoose hooks, so no invalidation). If the page still shows the old title, it came from the cache. Saving through Mongoose must then show the new one.

Local result: 140 tests, 137 passed, 3 skipped (no Redis on this machine), 0 failed. CI runs all 140 with a `redis:7.4.10-alpine` service. The Compose smoke test (`ci/smoke.js --expect-redis`) checks that the containerised app reports `redis: "ok"`.

### A6. Running it

```bash
docker compose up --build -d     # mongo + redis + app + worker
docker compose exec redis redis-cli keys "tbc:*"
docker compose exec redis redis-cli info stats   # keyspace_hits / keyspace_misses
```

Without Docker, nothing changes: leave `REDIS_URL` unset and the app runs as before.

---

## Part B: Going live with real payments

### B1. What the code now does

- **Policy pages:** `/contact`, `/terms`, `/privacy`, `/refund-policy` and `/delivery-policy`, linked from the footer on every page and from the booking box before payment. Razorpay checks for these when it reviews a website for activation. The text describes the code's actual behaviour: hold length (read from `BOOKING_HOLD_MINUTES`), cancellation before check-in, full refunds to the original method, automatic refunds for late or duplicate payments, and "refunded" only once the provider confirms. These are plain-language descriptions, not legal advice. Have them reviewed if you run this as a business.
- **No invented business details:** the footer used to say "TravelByChance Pvt. Ltd.", a company that doesn't exist. Name, email, phone and address now come from `BUSINESS_NAME`, `SUPPORT_EMAIL`, `SUPPORT_PHONE` and `BUSINESS_ADDRESS`. Without them, the Contact page says the details haven't been added; it doesn't make them up.
- **Honest payment wording:** with live keys the booking box says "Secure payment by Razorpay", never "Test mode, no real money".
- **Two locks on real money:** live keys (`rzp_live_…`) are refused unless `ALLOW_LIVE_PAYMENTS=true`, *and* the server refuses to start in live mode without `SUPPORT_EMAIL`, `SUPPORT_PHONE` and `BUSINESS_ADDRESS`.

### B2. Checklist (in order)

1. **Deploy the site** with HTTPS (Render + Atlas plan in [docs/08](08-milestone-7-ci-cd.md)). Razorpay reviews a public URL, not localhost.
2. **Set the business details** in the host's environment: `BUSINESS_NAME`, `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `BUSINESS_ADDRESS`.
3. **Run test mode on the deployed site first:** `RAZORPAY_KEY_ID=rzp_test_…`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, and a webhook in the Razorpay dashboard (Test Mode) pointing to `https://<your-site>/api/v1/webhooks/razorpay` with the events listed in [docs/05](05-milestone-4-payments.md) (`payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`). Do one full book → pay → cancel → refund with a test card.
4. **Activate the Razorpay account** with your own KYC (PAN, bank account, website URL). Only you can do this; it can't be automated.
5. **Switch to live:** generate live keys in Live Mode, create a **separate live webhook** (live and test webhooks are configured separately) with its own secret, and set `RAZORPAY_KEY_ID=rzp_live_…`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` and `ALLOW_LIVE_PAYMENTS=true`. Make sure `DEMO_PAYMENTS` is **not** set (the app refuses both together).
6. **Smoke-test with real money, small:** book the cheapest stay for one night, pay, confirm it shows Confirmed, cancel, and check that the refund reaches *Refunded* and arrives at the bank.

---

## Interview angles

**"Why did you add Redis, and why not for inventory?"** For two things where a shared, fast, disposable store is the right tool: rate-limit counters (with several instances, per-process counters multiply the limit) and a short-lived read cache. Inventory stays in MongoDB because it has to be updated in the same transaction as the booking and must survive a crash. Nothing in Redis matters if it's lost, so persistence is off.

**"What happens when Redis goes down?"** Nothing user-visible except speed. Reads go to MongoDB. Rate limits fall back to per-process counting: looser, but never off, which avoids both locking users out and dropping brute-force protection. Readiness stays green, so a cache outage can't take the site offline. A metric counts the fallbacks so an alert can fire.

**"How do you invalidate the cache?"** A generation number. Every key includes it, and every listing write bumps it through Mongoose model hooks, so no code path can forget. Old keys become unreachable and expire. I worked through the read/write race: the stale window is only between the DB commit and the bump, and if Redis misses a bump, the 60 s TTL bounds staleness. Prices and availability for booking never come from the cache.

**"How do you know two instances really share the limit?"** The integration test builds two separate app instances against one real Redis. Four attempts alternating between them hit the limit on the fourth, and Redis holds exactly one counter key, with a TTL.
