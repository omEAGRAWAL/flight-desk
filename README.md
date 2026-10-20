# Flight Desk

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `SERPAPI_KEY`, `SCRAPINGDOG_API_KEY`, and `ADMIN_KEY`
3. `npm start`  ->  http://localhost:3000   (admin: /admin.html)

Search Providers:
- **Any (Auto / Best & Fallback)**: Automatically queries available providers (SerpApi & Scrapingdog), deduplicates flights, surfaces best prices, and falls back gracefully if one provider is throttled or errors.
- **SerpApi**: Queries Google Flights via SerpApi.
- **Scrapingdog**: Queries Google Flights via Scrapingdog API (`https://api.scrapingdog.com/google_flights`).

Flow: search -> (round trip: pick outbound, then return) -> platform prices + your price (Rs 500 per passenger off) -> booking request form -> you book it manually -> mark booked + PNR in /admin.html -> customer checks status with their reference.

