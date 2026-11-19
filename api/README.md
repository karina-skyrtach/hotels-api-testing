# Hotels API

REST API for the Grand Carpathian Hotel staff (learning project for API testing).
Built with plain Node.js (built-in `node:http`, `node:sqlite`, `node:crypto`), no npm dependencies.

## Run

Requires Node.js 22.13+ (tested on Node 24).

```bash
cd api
npm start          # http://localhost:3000/api/v1
npm run db:reset   # restore the database to its initial state (stop the server first)
```

`npm run dev` restarts the server automatically when code changes.

## Database

- `hotel.db` — original seed database, never modified by the API.
- `hotel.local.db` — working copy used by the API (git-ignored). Created automatically on first start
  and recreated by `npm run db:reset`.

## Test accounts

| Username | Password | Role |
|---|---|---|
| `admin` | `Admin123!` | admin |
| `reception` | `Reception123!` | receptionist |
| `disabled` | `Disabled123!` | receptionist, `is_active = 0` (login → 403) |

## Endpoints (26)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login` |
| Room types, rooms | `GET /room-types`, `GET /room-types/:id`, `GET /rooms`, `GET /rooms/:id`, `PATCH /rooms/:id/status` |
| Availability | `GET /availability` |
| Rates, promo | `GET /rate-plans`, `GET /promo-codes/:code/validate` |
| Guests | `GET /guests`, `GET /guests/:id`, `POST /guests`, `PATCH /guests/:id`, `DELETE /guests/:id` |
| Bookings | `GET /bookings`, `GET /bookings/:code`, `POST /bookings`, `POST /bookings/:code/cancel`, `POST /bookings/:code/check-in`, `POST /bookings/:code/check-out` |
| Services | `GET /services`, `POST /bookings/:code/services` |
| Payments | `GET /bookings/:code/payments`, `POST /bookings/:code/payments` |
| Reviews | `GET /reviews`, `POST /bookings/:code/review` |

Full specification: [Hotels API — specification (Stage 2)](https://claude.ai/artifact/RXbViqY616x3HJSpxthGuf).
