# Flight Desk

1. `npm install`
2. Copy `.env.example` to `.env` and fill in SERPAPI_KEY and ADMIN_KEY
3. `npm start`  ->  http://localhost:3000   (admin: /admin.html)

Flow: search -> (round trip: pick outbound, then return) -> platform prices + your price (Rs 500 per passenger off) -> booking request form -> you book it manually -> mark booked + PNR in /admin.html -> customer checks status with their reference.
