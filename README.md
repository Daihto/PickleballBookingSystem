# Mactan Pickleball Club — Booking System

A full-stack demo for player court booking, Open Play, coaching, and staff operations.

## Stack

- React + TypeScript + Vite
- Express TypeScript API
- SQLite via `better-sqlite3`
- JWT staff authentication and bcrypt password hashing

## Run locally

```powershell
npm install
npm run dev
```

- Player app: http://localhost:5173
- API: http://localhost:3001
- Demo staff login: `staff@mactanpickleball.ph` / `staff123`

For a production-style local build:

```powershell
npm run build
copy .env.example .env
npm start
```

SQLite data is stored in `pickleball.db` by default. Delete it and restart to reseed demo data. Copy `.env.example` to `.env` and replace `JWT_SECRET` in real use.

## Demo data

The server creates the schema and seeds Mactan Pickleball Club, four courts, one demo staff account, and Open Play/Coaching sessions. Venue and court settings are stored in SQLite and can be changed in Staff → Courts.

## Assumptions

- Slots are one hour in Cebu/Asia-Manila date conventions.
- Pending and confirmed private bookings, sessions, and staff blocks share court availability.
- Submitted quote values are snapshotted. Later rate changes do not alter old quotes.
- Paddle rentals are ₱80 each with stock of 12.
- Pending, confirmed, and checked-in session registrations count toward capacity; waitlisted players do not.
- Declined/cancelled private bookings release slots.
- SQLite transactions and server-side conflict checks prevent simultaneous slot claims and stock oversubscription.

## Completed features

- Multi-court multi-slot booking, court tabs, grouped slots, paddle rental, quote review, status lookup
- Open Play and Coaching filters and registration/waitlist flows
- Staff JWT sign-in and protected APIs
- Request confirm/decline/cancel, manual booking, court blocking
- Session creation and roster confirm/check-in/release/promote
- Venue/court settings and weekday/weekend pricing
- Reports and responsive layouts

## Known limitations

- No live payment or email/SMS integration
- Staff manual and block actions use browser prompts
- No CSV export or QR check-in

## Manual acceptance checklist

1. Player submits two-court + paddle booking, staff confirms, and player looks it up by reference/mobile.
2. Change a court rate after submission and verify the stored quote stays unchanged.
3. Submit overlapping requests in separate browser contexts; one should be rejected.
4. Fill Open Play and create a waitlist player, release a spot, and promote the player.
5. Create a coaching session and verify private court overlap is rejected.
6. Test a phone-width screen and refresh after a successful lookup.

## Interface updates

- Black-accented, warm-neutral visual system with reduced visual noise
- Subtle entrance, hover, and modal motion with reduced-motion accessibility support
- Responsive player and staff layouts optimized for narrow phones
- All displayed session and booking times use 12-hour AM/PM formatting while backend values remain hourly integers

## Opening and date experience

- The app shows a short branded loading animation on first open.
- Booking and session date fields use the browser calendar picker and default to Cebu local time.
- Loading, empty, error, selected, unavailable, and success states are text-labelled as well as color-coded.

## Data model

SQLite tables store venues, staff, courts, private requests and slots, maintenance blocks, sessions, and session registrations. Shared court availability checks private slots, blocks, and sessions before saving. A partial unique index rejects duplicate active private court slots.

## Deployment and persistence

The local database is `pickleball.db`. Render deployments may use `DB_PATH=/tmp/pickleball.db` for a temporary demo or a persistent disk at `/var/data/pickleball.db`. The README and demo must disclose whether deployed data is temporary.

## Test coverage checklist

- Multi-court and paddle quote submission
- Private request staff confirmation and player reference lookup
- Server-side conflict and stock rechecks
- Cancellation and decline slot release
- Open Play, coaching, filters, waitlist, check-in, and promotion
- Staff JWT authorization
- Phone-width responsive layout and 12-hour Cebu time display

## Premium interface

- Custom particle-inspired pickleball opening screen
- Cohesive court-reservation and staff-operations design system
- Responsive player booking, sessions, lookup, and staff views
- Subtle entrance, loading, hover, and success feedback
- Reduced-motion support for accessibility

## Custom domain

A custom domain is not bundled with source code. In Render, open the service, select **Custom Domains**, and add the chosen hostname. Then create the DNS records Render provides at the domain registrar, typically a CNAME for a subdomain or A/ALIAS records for an apex domain. Wait for DNS verification before treating the Render URL as the primary public address.
