import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';

const {
  SERPAPI_KEY,
  SCRAPINGDOG_API_KEY = '6ad75f7e0602808fada0c4f1',
  ADMIN_KEY = 'om',
  PORT = 3000
} = process.env;
const DISCOUNT = Number(process.env.DISCOUNT_PER_PASSENGER ?? 500); // INR off per passenger
const DB = process.env.VERCEL ? path.join('/tmp', 'bookings.json') : './bookings.json';

if (!SERPAPI_KEY) {
  console.warn('Warning: SERPAPI_KEY is not set in environment variables');
}
if (!SCRAPINGDOG_API_KEY) {
  console.warn('Warning: SCRAPINGDOG_API_KEY is not set in environment variables');
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

let inMemoryStore = [];

const readDb = () => {
  try {
    if (fs.existsSync(DB)) {
      const content = fs.readFileSync(DB, 'utf8');
      if (content) {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed) && parsed.length >= inMemoryStore.length) {
          inMemoryStore = parsed;
          return inMemoryStore;
        }
      }
    }
  } catch (err) {
    console.error('Error reading DB:', err.message);
  }
  return inMemoryStore;
};

const writeDb = (d) => {
  inMemoryStore = d;
  try {
    const dir = path.dirname(DB);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB, JSON.stringify(d, null, 2));
  } catch (err) {
    console.error('Error writing DB:', err.message);
  }
};

// Direct page shortcuts
app.get('/admin', (req, res) => res.sendFile(path.resolve('public/admin.html')));
app.get('/book', (req, res) => res.sendFile(path.resolve('public/book.html')));

// ---- SerpApi helper (key never leaves the server) ----
async function serp(params) {
  if (!SERPAPI_KEY) {
    throw new Error('SERPAPI_KEY is not configured on the server');
  }
  const url = new URL('https://serpapi.com/search');
  const all = { engine: 'google_flights', currency: 'INR', gl: 'in', hl: 'en', ...params, api_key: SERPAPI_KEY };
  for (const [k, v] of Object.entries(all)) {
    if (v !== undefined && v !== '' && v !== null) url.searchParams.set(k, v);
  }
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) {
    // If Google Flights has no flights for this route or date, return empty list gracefully
    if (typeof j.error === 'string' && j.error.toLowerCase().includes("hasn't returned any results")) {
      return { best_flights: [], other_flights: [], no_results: true, provider: 'serpapi' };
    }
    throw new Error(j.error);
  }
  j.provider = 'serpapi';
  return j;
}

// ---- Scrapingdog helper (uses axios & handles google_flights endpoint) ----
async function scrapingdog(params) {
  const apiKey = SCRAPINGDOG_API_KEY || '6ad75f7e0602808fada0c4f1';
  if (!apiKey) {
    throw new Error('SCRAPINGDOG_API_KEY is not configured on the server');
  }
  const all = {
    currency: 'INR',
    gl: 'in',
    hl: 'en',
    country: 'in',
    language: 'en',
    ...params,
    api_key: apiKey
  };
  const cleanParams = {};
  for (const [k, v] of Object.entries(all)) {
    if (v !== undefined && v !== '' && v !== null) cleanParams[k] = v;
  }
  const response = await axios.get('https://api.scrapingdog.com/google_flights', {
    params: cleanParams,
    timeout: 30000
  });
  const j = response.data;
  if (j.error || (j.success === false && j.message)) {
    const errMsg = j.error || j.message;
    if (typeof errMsg === 'string' && (errMsg.toLowerCase().includes("hasn't returned any results") || errMsg.toLowerCase().includes('no results'))) {
      return { best_flights: [], other_flights: [], no_results: true, provider: 'scrapingdog' };
    }
    throw new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
  }
  j.provider = 'scrapingdog';
  return j;
}

// Multi-engine search coordinator: supports 'any' (auto fallback & merge), 'serpapi', 'scrapingdog'
async function searchFlights(params, requestedProvider = 'any') {
  const provider = (requestedProvider || 'any').toLowerCase().trim();

  if (provider === 'serpapi') {
    return serp(params);
  }

  if (provider === 'scrapingdog') {
    return scrapingdog(params);
  }

  // 'any' provider: Query both providers concurrently; fallback automatically if one fails
  const results = await Promise.allSettled([
    serp(params).then(res => ({ ...res, provider: 'serpapi' })),
    scrapingdog(params).then(res => ({ ...res, provider: 'scrapingdog' }))
  ]);

  const successful = [];
  const errors = [];

  if (results[0].status === 'fulfilled') successful.push(results[0].value);
  else errors.push(`SerpApi: ${results[0].reason?.message || 'Error'}`);

  if (results[1].status === 'fulfilled') successful.push(results[1].value);
  else errors.push(`Scrapingdog: ${results[1].reason?.message || 'Error'}`);

  if (successful.length === 0) {
    throw new Error(errors.join(' | ') || 'Failed to retrieve flights from any provider');
  }

  if (successful.length === 1) {
    return successful[0];
  }

  // Both succeeded: return combined response
  const [resA, resB] = successful;
  return {
    combined: true,
    provider: 'any',
    providersUsed: ['serpapi', 'scrapingdog'],
    best_flights: [...(resA.best_flights || []), ...(resB.best_flights || [])],
    other_flights: [...(resA.other_flights || []), ...(resB.other_flights || [])],
    price_insights: resA.price_insights || resB.price_insights
  };
}

// Map the web form's query to SerpApi/Scrapingdog params
function baseParams(q) {
  const isOneWay = q.tripType === 'oneway' || (!q.return && q.tripType !== 'roundtrip');
  const isRoundTrip = !isOneWay && !!q.return;

  return {
    departure_id: (q.from || '').toUpperCase(),
    arrival_id: (q.to || '').toUpperCase(),
    outbound_date: q.date,
    return_date: isRoundTrip ? q.return : undefined,
    type: isRoundTrip ? 1 : 2, // 1: Round trip, 2: One way
    adults: q.adults || 1,
    children: q.children || undefined,
    infants_in_seat: q.infants || undefined,
    travel_class: q.cls || 1,
    stops: q.stops || undefined,
  };
}

const paxCount = (q) => (+q.adults || 1) + (+q.children || 0) + (+q.infants || 0);
const ourPrice = (price, q) => Math.max(Math.round(price - DISCOUNT * paxCount(q)), 0);

const slim = (f, q, defaultProvider = 'serpapi') => ({
  provider: f.provider || defaultProvider,
  airline: f.airline || f.flights?.[0]?.airline || 'Unknown Airline',
  logo: f.airline_logo || f.flights?.[0]?.airline_logo || '',
  legs: (f.flights || []).map((l) => ({
    from: l.departure_airport?.id,
    fromName: l.departure_airport?.name,
    dep: l.departure_airport?.time,
    to: l.arrival_airport?.id,
    toName: l.arrival_airport?.name,
    arr: l.arrival_airport?.time,
    flightNo: l.flight_number,
    airline: l.airline,
    duration: l.duration,
  })),
  layovers: (f.layovers || []).map((l) => ({ id: l.id, duration: l.duration })),
  totalDuration: f.total_duration,
  googlePrice: f.price,
  ourPrice: f.price ? ourPrice(f.price, q) : null,
  departureToken: f.departure_token,
  bookingToken: f.booking_token,
});

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) { res.status(400).json({ error: e.message }); }
};

// 1) Search flights (outbound; for round trip price = total round trip)
app.get('/api/search', wrap(async (req) => {
  const params = baseParams(req.query);
  const requestedProvider = req.query.provider || 'any';
  const j = await searchFlights(params, requestedProvider);

  const rawList = [];
  const addFlights = (list, prov) => {
    (list || []).forEach(f => rawList.push({ ...f, provider: f.provider || prov }));
  };

  if (j.combined) {
    addFlights(j.best_flights, 'serpapi');
    addFlights(j.other_flights, 'scrapingdog');
  } else {
    addFlights(j.best_flights, j.provider);
    addFlights(j.other_flights, j.provider);
  }

  // Deduplicate flights by flight numbers & timings, preserving lowest price
  const flightMap = new Map();
  for (const f of rawList) {
    const flightObj = slim(f, req.query, f.provider || j.provider || 'serpapi');
    const key = flightObj.legs.map(l => `${l.from || ''}_${l.to || ''}_${l.flightNo || ''}_${l.dep || ''}`).join('__');
    
    if (!flightMap.has(key)) {
      flightMap.set(key, flightObj);
    } else {
      const existing = flightMap.get(key);
      if (flightObj.ourPrice && (!existing.ourPrice || flightObj.ourPrice < existing.ourPrice)) {
        flightMap.set(key, { ...flightObj, providerBadge: 'Both (Best Price)' });
      } else if (flightObj.logo && !existing.logo) {
        existing.logo = flightObj.logo;
      }
    }
  }

  const flights = Array.from(flightMap.values());
  flights.sort((a, b) => (a.ourPrice || 999999) - (b.ourPrice || 999999));

  const isRoundTrip = params.type === 1;
  return {
    flights,
    provider: j.provider || requestedProvider,
    providersUsed: j.providersUsed || [j.provider || requestedProvider],
    discount: DISCOUNT * paxCount(req.query),
    tripType: isRoundTrip ? 'roundtrip' : 'oneway',
    insights: j.price_insights
  };
}));

// 2) Round trip: pick outbound -> get return flights
app.get('/api/return', wrap(async (req) => {
  const provider = (req.query.provider || 'any').toLowerCase().trim();
  const searchParams = { ...baseParams(req.query), departure_token: req.query.departure_token };
  
  let j;
  if (provider === 'scrapingdog') {
    try {
      j = await scrapingdog(searchParams);
    } catch {
      j = await serp(searchParams);
    }
  } else {
    try {
      j = await serp(searchParams);
    } catch (e) {
      if (SCRAPINGDOG_API_KEY) {
        j = await scrapingdog(searchParams);
      } else {
        throw e;
      }
    }
  }

  const list = [...(j.best_flights || []), ...(j.other_flights || [])];
  return {
    flights: list.map((f) => slim(f, req.query, j.provider)),
    provider: j.provider
  };
}));

// 3) Booking options: which platform sells it for how much
app.get('/api/options', wrap(async (req) => {
  const provider = (req.query.provider || 'any').toLowerCase().trim();
  const searchParams = { ...baseParams(req.query), booking_token: req.query.booking_token };
  
  let j;
  if (provider === 'scrapingdog') {
    try {
      j = await scrapingdog(searchParams);
    } catch {
      j = await serp(searchParams);
    }
  } else {
    try {
      j = await serp(searchParams);
    } catch (e) {
      if (SCRAPINGDOG_API_KEY) {
        j = await scrapingdog(searchParams);
      } else {
        throw e;
      }
    }
  }

  const options = (j.booking_options || []).map((o) => {
    const t = o.together || o.departing || {};
    return { platform: t.book_with, price: t.price, ourPrice: t.price ? ourPrice(t.price, req.query) : null };
  }).filter((o) => o.platform && o.price);
  return { options, provider: j.provider };
}));

// 4) Submit a booking request
app.post('/api/book', (req, res) => {
  const b = req.body || {};
  
  // Extract fields supporting both new direct fields and legacy contact object
  const agentName = (b.agentName || b.contact?.agency || b.contact?.agentName || '').trim();
  const passengerName = (b.passengerName || b.passengers || b.contact?.name || '').trim();
  const email = (b.email || b.contact?.email || '').trim();
  const mobile = (b.mobile || b.contact?.phone || '').trim();

  if (!agentName) {
    return res.status(400).json({ error: 'Agent name is required' });
  }
  if (!passengerName) {
    return res.status(400).json({ error: 'Passenger name is required' });
  }
  if (!mobile) {
    return res.status(400).json({ error: 'Mobile number is required' });
  }
  if (!email) {
    return res.status(400).json({ error: 'Email address is required' });
  }

  const rec = {
    id: 'FD-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    createdAt: new Date().toISOString(),
    status: 'requested', // 'requested' | 'booked' | 'cancelled'
    pnr: null,
    agentName,
    passengerName,
    email,
    mobile,
    tripType: b.tripType || (b.itinerary?.outbound ? 'Round Trip' : 'One Way'),
    itinerary: b.itinerary || b.flightDetails || {},
    quotedPrice: Number(b.quotedPrice) || 0,
    googlePrice: Number(b.googlePrice) || Number(b.quotedPrice) || 0,
    notes: b.notes || '',
    contact: {
      name: passengerName,
      phone: mobile,
      email,
      agency: agentName
    },
    passengers: passengerName
  };

  const db = readDb();
  db.push(rec);
  writeDb(db);
  res.json({ id: rec.id, message: 'Booking request created successfully', booking: rec });
});

// 5) Check status with reference ID
app.get('/api/status/:id', (req, res) => {
  const r = readDb().find((x) => x.id === req.params.id.toUpperCase());
  if (!r) return res.status(404).json({ error: 'Reference not found' });
  res.json({
    id: r.id,
    status: r.status,
    pnr: r.pnr,
    agentName: r.agentName,
    passengerName: r.passengerName,
    tripType: r.tripType,
    quotedPrice: r.quotedPrice,
    createdAt: r.createdAt
  });
});

// ---- Admin endpoints ----
const admin = (req, res, next) => {
  const key = req.get('x-admin-key') || req.query.key;
  if (key === ADMIN_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized: Invalid Admin Key' });
};

app.get('/api/admin/bookings', admin, (req, res) => {
  const db = readDb();
  res.json([...db].reverse());
});

app.get('/api/admin/export', admin, (req, res) => {
  const db = readDb();
  res.setHeader('Content-Disposition', 'attachment; filename=flight_desk_bookings.json');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(db, null, 2));
});

app.get('/api/admin/stats', admin, (req, res) => {
  const db = readDb();
  const total = db.length;
  const requested = db.filter((b) => b.status === 'requested').length;
  const booked = db.filter((b) => b.status === 'booked').length;
  const cancelled = db.filter((b) => b.status === 'cancelled' || b.status === 'failed').length;
  const totalVolume = db.reduce((acc, b) => acc + (b.quotedPrice || 0), 0);
  res.json({ total, requested, booked, cancelled, totalVolume });
});

app.post('/api/admin/bookings/:id', admin, (req, res) => {
  const db = readDb();
  const r = db.find((x) => x.id === req.params.id.toUpperCase());
  if (!r) return res.status(404).json({ error: 'Booking not found' });
  if (req.body.status) r.status = req.body.status; // requested | booked | cancelled
  if (req.body.pnr !== undefined) r.pnr = req.body.pnr;
  writeDb(db);
  res.json(r);
});

app.delete('/api/admin/bookings/:id', admin, (req, res) => {
  const db = readDb();
  const idx = db.findIndex((x) => x.id === req.params.id.toUpperCase());
  if (idx === -1) return res.status(404).json({ error: 'Booking not found' });
  const removed = db.splice(idx, 1);
  writeDb(db);
  res.json({ message: 'Booking deleted', deleted: removed[0] });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Flight desk running on http://localhost:${PORT}`));
}

export default app;

