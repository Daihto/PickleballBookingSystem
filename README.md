# Mactan Pickleball Club

Booking and staff management for the club's courts and sessions.

## Getting started

You’ll need Node.js 20.19 or newer.

```sh
npm install
cp .env.example .env
npm run dev
```

The app runs at http://localhost:5173, and the API runs at http://localhost:3001.

On its first run, the local database gets the venue details, four courts, sample sessions, and a development staff account:

- Email: `staff@mactanpickleball.ph`
- Password: `staff123`

This account is for local development only. Don't use it in production.

## Admin account

Choose **Staff / Admin** on the login page. For a new production database, set `INITIAL_STAFF_PASSWORD` in the service environment before starting the app. It is only used to create the first staff account; changing it later won't change an existing password.

For local development, a new database uses `staff123` if `INITIAL_STAFF_PASSWORD` isn't set.

Players sign up with a password of at least eight characters. Existing accounts keep working after the password migration.

## Data and deployment

By default, the database is `pickleball.db` in the project directory. For deployment, use a persistent disk and point `DB_PATH` to it. Otherwise, bookings may be lost when the service restarts or redeploys.

Set these variables in production:

```text
NODE_ENV=production
DB_PATH=/path/on/persistent/storage/pickleball.db
JWT_SECRET=<a unique random secret of at least 32 characters>
INITIAL_STAFF_PASSWORD=<a strong password for the first staff account>
```

Keep the database and `.env` private. Back up the database before upgrading it; deleting it removes accounts, bookings, settings, and other saved data. Database migrations run at startup and preserve existing records.

## What’s included

- Player registration, login, booking history, and session requests
- Court availability, multi-hour bookings, pricing, and equipment rentals
- Open Play and coaching sessions, including capacity and waitlist handling
- Staff tools for reviewing bookings, managing courts and sessions, and viewing reports
- Asia/Manila dates and Philippine peso prices

Bookings keep the prices quoted when they were submitted. SQLite transactions and constraints prevent overlapping court reservations and duplicate registrations.

## Checks

```sh
npm test
npm run build
npm run lint
```

Run `npm start` after building to serve the production app and API.

## Not included

Payments, email or SMS notifications, QR check-in, and CSV export aren't set up. The app uses SQLite and is intended for a single server instance with persistent storage.
