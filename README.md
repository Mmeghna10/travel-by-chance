# TravelByChance

A server-rendered travel stays marketplace in the style of Airbnb. Browse listings by category, search with live suggestions, read and write reviews, view each stay on a map, and book a stay. Hosts (admins) manage listings and see an overview dashboard.

Built with Node.js, Express, EJS and MongoDB.

## Features

- **Browse and search**: filter listings by category, free-text search across title, location, country and description, and real-time autocomplete suggestions.
- **11 categories**: Trending, Rooms, Iconic Cities, Mountains, Castles, Amazing Pools, Camping, Farms, Arctic, Domes, Boats.
- **Listing pages** with image, description, average star rating, reviews, and a Mapbox map pinned to the location.
- **Bookings**: pick check-in and check-out dates and see a live price breakdown (nightly rate × nights, plus a 5% cleaning fee and a 12% service fee). Guests can view their bookings under **My Bookings**.
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
├── app.js                  # App entry: DB, sessions, passport, routes, error handling
├── cloudConfig.js          # Cloudinary + Multer storage config
├── middleware.js           # isLoggedIn, isOwner, isAdmin, isReviewAuthor, Joi validators
├── schema.js               # Joi schemas for listings and reviews
├── controllers/            # admin, bookings, listings, review, user
├── models/                 # User, Listing, Review, Booking
├── routes/                 # listing, review, user, bookings, admin
├── views/                  # EJS templates (layouts, includes, listings, users, admin, landing)
├── public/                 # css/ and client-side js/ (map, form validation)
├── init/                   # Seed data + seeding and migration scripts
├── scratch/                # Ad-hoc manual test/debug scripts
└── utils/                  # ExpressError, wrapAsync
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

When `NODE_ENV=production`, `.env` is not loaded, so set these variables in your hosting provider's dashboard instead.

### 3. Run the app

```bash
npm run dev     # development, auto-restarts with nodemon
npm start       # production
```

Open http://localhost:8080.

### 4. (Optional) Seed sample listings

1. Start the app and **sign up at least one account**. Seeding assigns listings to a user (it prefers a user named `demo`, otherwise the first user found).
2. Run:

```bash
node init/index.js
```

> **Warning:** the seed script **deletes all existing listings** before inserting the sample data. It also assigns placeholder map coordinates to every listing, so seeded stays share one pin location. Listings created through the app are geocoded from their location.

### 5. Create your first admin

On the sign-up page, choose **Host / Admin** under "Register As". Admins land on `/admin` after logging in and can add listings from the navbar.

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
| POST | `/bookings` | Logged in | Create a booking (JSON: `listingId`, `checkIn`, `checkOut`) |
| GET | `/bookings` | Logged in | Your bookings |
| GET | `/admin` | Admin | Admin dashboard |
| GET/POST | `/signup`, `/login` | Public | Register and log in |
| GET | `/logout` | Logged in | Log out |
| GET | `/api/search-suggestions?q=` | Public | JSON autocomplete (min. 2 characters, up to 8 results) |

## Data model

- **User**: `username`, `email` (unique), `role` (`customer` | `admin`), plus password hash and salt from `passport-local-mongoose`
- **Listing**: `title`, `description`, `image` (`url`, `filename`), `price` (per night, INR), `location`, `country`, `category`, `geometry` (GeoJSON point), `reviews[]`, `owner`
- **Review**: `rating` (1–5), `comment`, `author`, `createdAt`
- **Booking**: `listing`, `user`, `checkIn`, `checkOut`, `totalPrice`, `createdAt`

Prices are displayed in Indian rupees (₹).

## Scripts and utilities

| Command | Description |
| ------- | ----------- |
| `npm start` | Run the server |
| `npm run dev` | Run with nodemon |
| `node init/index.js` | Reset and seed sample listings |
| `node init/migrate_categories.js` | Assign a category to existing listings based on their title and description |

The `scratch/` folder holds throwaway scripts for manual checks (database inspection, DNS resolution, role access, search suggestions). They are not an automated test suite, and `npm test` is not configured yet.

## Troubleshooting

- **Cannot connect to MongoDB Atlas** (SRV/DNS errors): the app forces Google DNS (`8.8.8.8`, `8.8.4.4`) at startup to work around this. `scratch/test_dns.js` can help diagnose it. Also check that your IP is on the Atlas allow-list.
- **Map doesn't load**: confirm `MAP_TOKEN` is set to a valid Mapbox public token.
- **Image upload fails**: confirm the three `CLOUD_*` values are correct. Only PNG and JPG are accepted.

## Known limitations

- Anyone can pick the **Host / Admin** role at sign-up, so this is suitable for demos and learning but not production without adding an approval step.
- Bookings are confirmed immediately. There is no payment step and no check for overlapping dates on the same listing.

## License

ISC (as declared in `package.json`).
