# TravelByChance

A server-rendered travel stays marketplace in the style of Airbnb. Browse listings by category, search with live suggestions, read and write reviews, view each stay on a map, and book a stay. Hosts (admins) manage listings and see an overview dashboard.

Built with Node.js, Express, EJS and MongoDB.

## Features

- **Browse and search**: filter listings by category, free-text search across title, location, country and description, and real-time autocomplete suggestions.
- **11 categories**: Trending, Rooms, Iconic Cities, Mountains, Castles, Amazing Pools, Camping, Farms, Arctic, Domes, Boats.
- **Listing pages** with image, description, average star rating, reviews, and a Mapbox map pinned to the location.
- **Bookings without double booking**: pick dates to see live availability and a server-computed price (nightly rate × nights, plus a 5% cleaning fee and a 12% service fee, each on one night's rate, once per stay). Each listing has a number of bookable `units`; nights are reserved atomically inside a MongoDB transaction so a night can never be oversold, even under 100 simultaneous requests. Booking requests are idempotent (`Idempotency-Key`), so double clicks and retries never create duplicates. See [docs/03-milestone-2-booking-core.md](docs/03-milestone-2-booking-core.md).
- **Booking lifecycle**: an explicit state machine (`PENDING_PAYMENT`, `CONFIRMED`, `EXPIRED`, `CANCELLED`, `REFUND_PENDING`, …) with guarded, audited transitions. Guests can cancel before check-in, which releases the dates. Unpaid holds expire automatically via a background worker. See [docs/04-milestone-3-lifecycle.md](docs/04-milestone-3-lifecycle.md).
- **Observability**: structured JSON logs (pino) with a request ID on every line, Prometheus metrics at `/metrics` (latency per route, booking outcomes, inventory conflicts, payment/refund/webhook outcomes, MongoDB command latency and write conflicts), an error-reporting hook, and a load-test harness that checks booking correctness under load. See [docs/07-milestone-6-observability.md](docs/07-milestone-6-observability.md).
- **CI/CD**: GitHub Actions runs lint and tests, a dependency audit, a Docker build with in-container tests, a Compose smoke test (including graceful shutdown and data persistence) and an image scan on every push; `main` publishes the image to GHCR and deploys that exact digest. See [docs/08-milestone-7-ci-cd.md](docs/08-milestone-7-ci-cd.md) for the pipeline and the deployment plan.
- **Payments (Razorpay, test mode)**: dates are held while the guest pays through Razorpay Checkout. Bookings are confirmed only after server-side signature verification plus a captured status fetched from Razorpay, or a signed webhook. Duplicate and out-of-order webhooks are handled, refunds are queued through a transactional outbox, and a reconciliation job catches payments nobody reported. See [docs/05-milestone-4-payments.md](docs/05-milestone-4-payments.md).
- **Reviews**: logged-in users can leave a 1–5 star review; only the author can delete their own.
- **Authentication**: sign up, log in and log out with Passport (local strategy). Sessions are stored in MongoDB.
- **Roles**: `customer` and `admin` (Host). Only admins can create listings; only a listing's owner can edit or delete it.
- **Admin dashboard** (`/admin`): totals for listings, bookings and users, plus lists of all listings and bookings.
- **Image uploads** to Cloudinary, and **automatic geocoding** of the listing location via Mapbox when a listing is created.
- **Landing page** with featured stays, validated forms (Joi on the server, Bootstrap validation on the client) and flash messages.

## Tech stack

| Layer      | Technology |
| ---------- | ---------- |
| Server     | Node.js 22, Express 5 |
| Views      | EJS with `ejs-mate` layouts, Bootstrap 5.3, Font Awesome |
| Database   | MongoDB with Mongoose 8 |
| Auth       | Passport, `passport-local`, `passport-local-mongoose`, `express-session`, `connect-mongo`, `connect-flash` |
| Validation | Joi |
| Media      | Multer, `multer-storage-cloudinary`, Cloudinary |
| Maps       | Mapbox GL JS (display) and `@mapbox/mapbox-sdk` (geocoding) |

## Project structure

```
travel-by-chance/
├── server.js               # Process entry: config, DB connect, listen, graceful shutdown
├── app.js                  # createApp(): middleware, security headers, sessions, routes, errors
├── config/env.js           # Loads .env, optional DNS override, required-variable check
├── cloudConfig.js          # Cloudinary + Multer storage config
├── middleware.js           # isLoggedIn, isOwner, isAdmin, isReviewAuthor, Joi validators
├── middleware/rateLimits.js# Login/signup and booking rate limiters
├── schema.js               # Joi schemas for listings, reviews and signup
├── controllers/            # admin, bookings, listings, review, user
├── models/                 # User, Listing, Review, Booking
├── routes/                 # listing, review, user, bookings, admin
├── views/                  # EJS templates (layouts, includes, listings, users, admin, landing)
├── public/                 # css/ and client-side js/ (map, form validation)
├── init/                   # Seed data, seeding/migration scripts, create-admin
├── test/                   # Automated tests (node:test + supertest + in-memory MongoDB)
├── docs/                   # Audit, architecture and milestone notes
├── scratch/                # Ad-hoc manual test/debug scripts
└── utils/                  # ExpressError, wrapAsync, safeJson, escapeRegex
```

## Getting started

### Prerequisites

- **Node.js 22.x** (`>=22.9.0 <23`, as set in `package.json`)
- A MongoDB database: local install or a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster
- A free [Cloudinary](https://cloudinary.com/) account (image uploads)
- A free [Mapbox](https://www.mapbox.com/) account (a public access token)

### 1. Clone and install

```bash
git clone <your-repo-url>
cd travel-by-chance
npm install
```

### 2. Configure environment variables

Copy the example file and fill it in:

```bash
cp .env.example .env
```

| Variable           | Description |
| ------------------ | ----------- |
| `ATLASDB_URL`      | MongoDB connection string (`mongodb://127.0.0.1:27017/travelbychance` for local) |
| `SECRET`           | Secret used to sign session cookies and encrypt the session store |
| `CLOUD_NAME`       | Cloudinary cloud name |
| `CLOUD_API_KEY`    | Cloudinary API key |
| `CLOUD_API_SECRET` | Cloudinary API secret |
| `MAP_TOKEN`        | Mapbox public access token |
| `PORT`             | Optional. Defaults to `8080` |
| `DNS_SERVERS`      | Optional. Comma-separated resolvers (e.g. `8.8.8.8,8.8.4.4`) if your network can't resolve Atlas SRV records |
| `LOG_LEVEL` / `LOG_PRETTY` | Optional. Log level (default `info`); `LOG_PRETTY=true` for human-readable dev logs |
| `METRICS_TOKEN`    | Optional. If set, `/metrics` requires `Authorization: Bearer <token>` (set it anywhere public) |
| `SLOW_QUERY_MS`    | Optional. Log MongoDB commands slower than this (default 200) |
| `RATE_LIMIT_AUTH_MAX` / `RATE_LIMIT_BOOKING_MAX` | Optional. Override rate limits (only for load tests) |
| `HTTPS_ONLY`       | Optional. `true` = Secure cookies (needs HTTPS). Defaults to `true` when `NODE_ENV=production`; set `false` for plain `http://` |
| `TRUST_PROXY`      | Optional. Number of reverse proxies in front of the app (set `1` behind nginx/Render/Railway) |
| `ADMIN_PASSWORD`   | Only read by `npm run create-admin` |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay **test** API keys. Without them payments are off and bookings confirm instantly |
| `RAZORPAY_WEBHOOK_SECRET` | Secret configured on the Razorpay webhook (optional locally) |
| `REQUIRE_PAYMENT`  | Defaults to `true` when Razorpay keys are set |
| `BOOKING_HOLD_MINUTES` | How long an unpaid booking holds its dates (default 15) |
| `RUN_BACKGROUND_JOBS` | `false` to stop the web process from running background jobs (then run `npm run worker`) |
| `JOB_INTERVAL_SECONDS` | How often hold expiry, refunds and reconciliation run (default 30) |

The server refuses to start if `ATLASDB_URL` or `SECRET` is missing or the database is unreachable.

When `NODE_ENV=production`, `.env` is not loaded, so set these variables in your hosting provider's dashboard instead.

### 3. Run the app

```bash
npm run dev     # development, auto-restarts with nodemon
npm start       # production
```

Open http://localhost:8080.

### 3b. Or run everything with Docker

With Docker Desktop installed, this starts MongoDB (as a replica set), the app and the background worker. Secrets are read from your `.env` at runtime; containers always use the bundled MongoDB, not `ATLASDB_URL`:

```bash
docker compose up --build -d
```

Then open http://localhost:8080. Stop with `docker compose down` (data is kept in a volume). Live-reload dev mode, all commands and troubleshooting are in [docs/06-milestone-5-docker.md](docs/06-milestone-5-docker.md).

### 4. (Optional) Seed sample listings

1. Start the app and **sign up at least one account**. Seeding assigns listings to a user (it prefers a user named `demo`, otherwise the first user found).
2. Run:

```bash
npm run seed
```

> **Warning:** the seed script **deletes all existing listings** before inserting the sample data. It also assigns placeholder map coordinates to every listing, so seeded stays share one pin location. Listings created through the app are geocoded from their location.

### 5. Create your first admin

Public sign-up always creates a **customer**. Admin (host) accounts are created from the command line:

```powershell
$env:ADMIN_PASSWORD = "choose-a-strong-password"
npm run create-admin -- --username host1 --email host1@example.com
```

Promote an existing user with `npm run create-admin -- --promote <username>`, and list admins with `npm run create-admin -- --list`. Admins land on `/admin` after logging in and can add listings from the navbar.

## Routes

| Method | Path | Access | Description |
| ------ | ---- | ------ | ----------- |
| GET | `/` | Public | Landing page with featured stays |
| GET | `/listings` | Public | All listings; supports `?q=` and `?category=` |
| GET | `/listings/new` | Admin | New listing form |
| POST | `/listings` | Admin | Create a listing (image upload + geocoding) |
| GET | `/listings/:id` | Public | Listing details, reviews and map |
| GET | `/listings/:id/edit` | Owner | Edit form |
| PUT | `/listings/:id` | Owner | Update a listing |
| DELETE | `/listings/:id` | Owner | Delete a listing and its reviews |
| POST | `/listings/:id/reviews` | Logged in | Add a review |
| DELETE | `/listings/:id/reviews/:reviewId` | Review author | Delete a review |
| GET | `/api/v1/listings/:id/quote?checkIn=&checkOut=` | Public | Price breakdown and availability (JSON) |
| POST | `/api/v1/bookings` | Logged in | Create a booking (JSON: `listingId`, `checkIn`, `checkOut`; header `Idempotency-Key`) |
| GET | `/api/v1/bookings/:id` | Owner | Booking status (JSON) |
| POST | `/api/v1/bookings/:id/cancel` | Owner | Cancel (JSON) |
| POST | `/bookings/:id/cancel` | Owner | Cancel from the My Bookings page |
| POST | `/api/v1/bookings/:id/payment-order` | Owner | Create or reuse the Razorpay order for a held booking |
| POST | `/api/v1/payments/verify` | Logged in | Verify the Checkout response (signature + API fetch) |
| POST | `/api/v1/webhooks/razorpay` | Razorpay (signed) | Webhook receiver (raw body, HMAC-verified) |
| GET | `/bookings` | Logged in | Your bookings |
| GET | `/admin` | Admin | Admin dashboard |
| GET/POST | `/signup`, `/login` | Public | Register and log in |
| GET | `/logout` | Logged in | Log out |
| GET | `/api/search-suggestions?q=` | Public | JSON autocomplete (min. 2 characters, up to 8 results) |
| GET | `/healthz` | Public | Liveness probe (process is up) |
| GET | `/readyz` | Public | Readiness probe (database reachable), 503 otherwise |
| GET | `/metrics` | Token (if `METRICS_TOKEN` set) | Prometheus metrics |

## Data model

- **User**: `username`, `email` (unique), `role` (`customer` | `admin`), plus password hash and salt from `passport-local-mongoose`
- **Listing**: `title`, `description`, `image` (`url`, `filename`), `price` (per night, INR), `location`, `country`, `category`, `geometry` (GeoJSON point), `reviews[]`, `owner`
- **Review**: `rating` (1–5), `comment`, `author`, `createdAt`
- **Listing** also has `units` (bookable units per night, default 1)
- **Booking**: `listing`, `user`, `checkIn`, `checkOut`, `status`, `nights`, `amountPaise`, `currency`, `priceBreakdown`, `totalPrice` (rupees), `createdAt`
- **InventoryNight**: `listing`, `date`, `reserved`; unique per listing-night
- **IdempotencyRecord**: `user`, `scope`, `key`, `requestHash`, stored response; unique per user+scope+key, deleted after 24 h

Prices are displayed in Indian rupees (₹).

## Scripts and utilities

| Command | Description |
| ------- | ----------- |
| `npm start` | Run the server |
| `npm run dev` | Run with nodemon |
| `npm run lint` | ESLint (must pass in CI) |
| `npm test` | Run the automated tests (downloads a MongoDB binary on first run) |
| `npm run seed` | Reset and seed sample listings |
| `npm run create-admin` | Create, promote or list admin accounts |
| `npm run load:baseline` | Local load test: throughput, latency percentiles and booking correctness under load |
| `npm run worker` | Run background jobs (expiry, refunds, reconciliation) as their own process |
| `npm run migrate:bookings` | Dry-run (add `-- --apply` to write) moving pre-existing bookings onto the inventory model |
| `node init/migrate_categories.js` | Assign a category to existing listings based on their title and description |

The `scratch/` folder holds older throwaway scripts for manual checks; the automated suite lives in `test/`.

## Troubleshooting

- **Cannot connect to MongoDB Atlas** (SRV/DNS errors): set `DNS_SERVERS=8.8.8.8,8.8.4.4` in `.env`. `scratch/test_dns.js` can help diagnose it. Also check that your IP is on the Atlas allow-list.
- **Map doesn't load**: confirm `MAP_TOKEN` is set to a valid Mapbox public token.
- **Image upload fails**: confirm the three `CLOUD_*` values are correct. Only PNG and JPG are accepted.

## Known limitations

- The Content-Security-Policy still allows inline scripts because the views use inline `<script>` blocks and `onclick` attributes.
- Without Razorpay keys, bookings are confirmed immediately (no payment). Changing a booking's dates isn't supported; cancel and rebook instead.
- Refunds are always full refunds; there's no partial-refund policy and no admin screen for `REFUND_FAILED` bookings yet.
- **Docker setup not yet run in Docker:** the Dockerfile and Compose files are schema-validated and the production image was rehearsed without Docker, but the stack hasn't been built or run under Docker yet. See [docs/06-milestone-5-docker.md](docs/06-milestone-5-docker.md).
- **Live Razorpay sandbox check pending:** payments are tested against a Razorpay simulator (real HMAC signatures) and Checkout was verified to load in the browser, but no real test-mode payment, webhook or refund has been run yet (test keys were blocked by KYC onboarding). See [docs/05-milestone-4-payments.md](docs/05-milestone-4-payments.md#-pending-live-razorpay-sandbox-check).

## License

ISC (as declared in `package.json`).
