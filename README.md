# Mactan Pickleball Club — Booking System

A full-stack booking application for private court reservations, Open Play, coaching, and staff operations.

## Stack

- React, TypeScript, and Vite
- Express API
- SQLite (`better-sqlite3`) with persistent local storage
- bcrypt password hashing and signed, expiring JWTs

## Run locally

Requires Node.js 20.19 or newer.

```sh
npm install
cp .env.example .env
npm run dev
```

- Player app: http://localhost:5173
- API: http://localhost:3001

The first local database is seeded once with venue details, four courts, a development staff account, and sample sessions. The local-only staff login is `staff@mactanpickleball.ph` / `staff123`. Staff credentials are not prefilled in the UI.

Run the application checks:

```sh
npm test
npm run build
npm run lint
```

`npm start` serves the production build and API together after `npm run build`.

## Data and migrations

The default SQLite file is `pickleball.db` in the working directory. Set `DB_PATH` to an absolute path on durable storage when deploying. The application adds its schema migrations at startup; migrations preserve existing bookings, sessions, and registrations. Seeds are inserted only when the corresponding tables are empty; restarting does not reset user data.

Back up the database before upgrading or moving it. Deleting the database permanently removes all saved bookings, accounts, registrations, settings, and staff credentials; it is not a routine reset step.

SQLite transactions, overlap triggers, and unique indexes protect court slots, published sessions, blocks, and active registrations. Submitted rates and equipment totals are stored with each booking, so later settings changes do not rewrite existing quotes. Equipment stock is checked against overlapping bookings.

## Production configuration

Use a persistent disk for the database and set these environment variables:

```text
NODE_ENV=production
DB_PATH=/path/on/persistent/storage/pickleball.db
JWT_SECRET=<a unique random secret of at least 32 characters>
INITIAL_STAFF_PASSWORD=<a strong initial password for a new database>
```

`INITIAL_STAFF_PASSWORD` is only used when a database has no staff account. The development fallback password and JWT secret are not used in production. Keep `.env` and database files private, and do not use temporary storage if bookings must survive a redeploy.

## Administrator sign-in

On the login page, choose **Staff / Admin** and sign in with `staff@mactanpickleball.ph`. For a new database, the password is the value of `INITIAL_STAFF_PASSWORD`; set it privately in Render's service environment before the first start. The application does not display or return that password.

For local development only, a new database uses `staff123` when `INITIAL_STAFF_PASSWORD` is unset. Do not use this fallback in production. Changing `INITIAL_STAFF_PASSWORD` after a staff account already exists does not reset that account's password.

This pickleball application has **Player** and **Staff / Admin** roles. Teacher and Student roles are not part of its implemented workflows.

Player accounts now use passwords of at least eight characters. Existing credential hashes are migrated in place, so current players can continue using their existing credential in the Password field.

## Implemented workflows

- Live availability from SQLite, multi-court/hour selection, database-priced quotes, equipment inventory, atomic booking submission, unique references, and status lookup.
- Player password registration/login and persistent booking/session history.
- Published Open Play and coaching sessions, skill/date filters, capacity checks, duplicate prevention, waitlists, and automatic FIFO promotion after a spot is released.
- Protected staff login/logout and dashboard operations for booking review, manual bookings, court blocks, session creation/editing/publishing, rosters, check-in, venue details, hours/weekly closures, pricing, equipment settings, and date-based reports.
- Asia/Manila date calculations and Philippine peso display.

## Limitations

- Payments, email/SMS notifications, QR check-in, and CSV export are not integrated.
- SQLite is suitable for a single-instance deployment on persistent storage. Multi-instance deployments should use a shared database with equivalent transaction and constraint guarantees.
- The bundled staff account is for local development only. Provision a strong initial password and rotate it before production use.
