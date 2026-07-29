// Routing + geocoding.
//
// Accuracy policy (operator-defined): nearest-city precision is industry-normal
// for long-haul, but ±1 hour of ETA error is not acceptable, and tighter
// accuracy is wanted once the truck is within ~100 miles / ~1 hour.
//
//   > 100 mi or > 1 h remaining : OpenRouteService driving-hgv (free-flow)
//                                 + time-of-day padding.   Target ≤ ±30 min.
//   ≤ 100 mi or ≤ 1 h remaining : Mapbox driving-traffic.   Target ≤ ±15 min.
//   < 1 mi                      : Arrived.
//
// ORS is truck-aware (driving-hgv respects weight/height/bridge restrictions),
// which Mapbox's driving-traffic profile is not — so ORS is the better *router*
// and Mapbox is bought only for its live traffic on the final approach.

import { bumpUsage, underCap, nominatimGate } from "./usage";

const ORS_BASE = "https://api.openrouteservice.org";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const METERS_PER_MILE = 1609.344;

// Inside this radius we spend a Mapbox call for traffic-aware timing.
const CLOSE_MILES = Number(process.env.CLOSE_IN_MILES || 100);
const CLOSE_SECONDS = Number(process.env.CLOSE_IN_SECONDS || 3600);
// Straight-line can only ever be shorter than road distance, so anything beyond
// this is guaranteed to be outside CLOSE_MILES — lets us skip a routing call
// before deciding which engine to use.
const DEFINITELY_FAR_MILES = CLOSE_MILES * 1.2;

export const ARRIVAL_MILES = Number(process.env.ARRIVAL_MILES || 1);

// ---- geometry (free, no API) -------------------------------------------

export function haversineMiles(a, b) {
  if (!a || !b) return null;
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---- traffic padding ----------------------------------------------------
//
// ORS returns free-flow time. Over a 20-hour haul, congestion is noise against
// hours of slack — but it is not noise on the last leg into a metro, which is
// exactly why Mapbox takes over inside CLOSE_MILES. This model only has to be
// good enough for the far field.

export function paddingFactor(atMs, timeZone) {
  let hour = new Date(atMs).getUTCHours();
  let weekday = new Date(atMs).getUTCDay();
  if (timeZone) {
    try {
      const p = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        hour12: false,
        weekday: "short",
      }).formatToParts(new Date(atMs));
      const h = p.find((x) => x.type === "hour")?.value;
      const w = p.find((x) => x.type === "weekday")?.value;
      if (h != null) hour = parseInt(h, 10) % 24;
      if (w) weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(w);
    } catch {
      /* fall back to UTC */
    }
  }
  const isWeekend = weekday === 0 || weekday === 6;
  if (hour >= 22 || hour < 5) return 1.0; // overnight running
  if (isWeekend) return 1.08;
  if ((hour >= 7 && hour < 9) || (hour >= 16 && hour < 19)) return 1.3; // rush
  return 1.15; // ordinary daytime
}

// ---- geocoding ----------------------------------------------------------
//
// Chain: Nominatim (free, strict policy) -> ORS/Pelias (free) -> Google (paid,
// optional). Results are cached per load in the database, so this runs once per
// destination rather than once per check.

export async function geocode(address) {
  if (!address) return null;
  const attempts = [
    ["nominatim", geocodeNominatim],
    ["ors", geocodeOrs],
    ["google", geocodeGoogle],
  ];
  let lastErr = null;
  for (const [provider, fn] of attempts) {
    if (provider === "google" && !process.env.GOOGLE_MAPS_KEY) continue;
    if (provider === "ors" && !process.env.ORS_API_KEY) continue;
    if (!(await underCap(provider))) continue;
    try {
      const hit = await fn(address);
      await bumpUsage(provider);
      if (hit) return { ...hit, provider };
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

async function geocodeNominatim(address) {
  await nominatimGate();
  const url = new URL(NOMINATIM);
  url.searchParams.set("q", address);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "us");
  const res = await fetch(url, {
    headers: {
      // Nominatim's policy REQUIRES an identifying User-Agent with contact info.
      "User-Agent": process.env.NOMINATIM_UA || "STLTruckersLoadTracker/2.0 (dispatch@stltruckers.com)",
      "Accept-Language": "en-US,en",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Nominatim geocode failed (${res.status})`);
  const j = await res.json();
  const f = Array.isArray(j) ? j[0] : null;
  if (!f) return null;
  return { lat: Number(f.lat), lng: Number(f.lon) };
}

async function geocodeOrs(address) {
  const url = new URL(`${ORS_BASE}/geocode/search`);
  url.searchParams.set("api_key", orsKey());
  url.searchParams.set("text", address);
  url.searchParams.set("boundary.country", "US");
  url.searchParams.set("size", "1");
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`ORS geocode failed (${res.status})`);
  const j = await res.json();
  const c = j.features?.[0]?.geometry?.coordinates;
  if (!c) return null;
  return { lat: c[1], lng: c[0] };
}

async function geocodeGoogle(address) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", process.env.GOOGLE_MAPS_KEY);
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Google geocode failed (${res.status})`);
  const j = await res.json();
  const loc = j.results?.[0]?.geometry?.location;
  return loc ? { lat: loc.lat, lng: loc.lng } : null;
}

// ---- routing ------------------------------------------------------------

function orsKey() {
  const k = process.env.ORS_API_KEY;
  if (!k) throw new Error("Missing ORS_API_KEY env var.");
  return k;
}

// Truck-legal free-flow route. Returns { seconds, meters }.
async function routeOrs(origin, dest) {
  const res = await fetch(`${ORS_BASE}/v2/directions/driving-hgv`, {
    method: "POST",
    headers: {
      Authorization: orsKey(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      coordinates: [
        [origin.lng, origin.lat],
        [dest.lng, dest.lat],
      ],
      units: "m",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ORS route failed (${res.status}): ${body.slice(0, 160)}`);
  }
  const j = await res.json();
  const s = j.routes?.[0]?.summary;
  if (!s || typeof s.duration !== "number") throw new Error("No truck route to destination.");
  return { seconds: s.duration, meters: s.distance ?? null };
}

// Traffic-aware, used only on the final approach.
async function routeMapbox(origin, dest) {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error("Missing MAPBOX_TOKEN env var.");
  const coords = `${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
  const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("overview", "false");
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Mapbox directions failed (${res.status})`);
  const j = await res.json();
  const r = j.routes?.[0];
  if (!r || typeof r.duration !== "number") throw new Error("No route found to destination.");
  return { seconds: r.duration, meters: r.distance ?? null };
}

/**
 * Estimate arrival for one leg.
 *
 * Returns { seconds, milesLeft, provider, padded, arrived } where `seconds` is
 * the traffic-adjusted estimate. Callers should check `arrived` first — it is
 * decided by straight-line distance and costs no API quota at all.
 */
export async function estimateEta(origin, dest, { timeZone = null, now = Date.now() } = {}) {
  const straight = haversineMiles(origin, dest);

  // Arrival is a pure geometry question. Answering it here means the last check
  // of a load's life makes zero provider calls.
  if (straight != null && straight < ARRIVAL_MILES) {
    return { seconds: 0, milesLeft: straight, provider: "haversine", padded: false, arrived: true };
  }

  const definitelyFar = straight != null && straight > DEFINITELY_FAR_MILES;

  let base = null;
  let orsErr = null;
  if (await underCap("ors")) {
    try {
      base = await routeOrs(origin, dest);
      await bumpUsage("ors");
    } catch (e) {
      orsErr = e;
    }
  }

  const milesLeft = base?.meters != null ? base.meters / METERS_PER_MILE : straight;
  const closeIn =
    !definitelyFar &&
    ((milesLeft != null && milesLeft <= CLOSE_MILES) ||
      (base && base.seconds <= CLOSE_SECONDS));

  // Inside the accuracy window, buy live traffic — this is the only place we
  // ever spend Mapbox quota.
  if (closeIn && process.env.MAPBOX_TOKEN && (await underCap("mapbox"))) {
    try {
      const live = await routeMapbox(origin, dest);
      await bumpUsage("mapbox");
      return {
        seconds: live.seconds,
        milesLeft: live.meters != null ? live.meters / METERS_PER_MILE : milesLeft,
        provider: "mapbox",
        padded: false,
        arrived: false,
      };
    } catch {
      // fall through to the padded ORS answer rather than failing the check
    }
  }

  if (!base) throw orsErr || new Error("No routing provider available.");

  const factor = paddingFactor(now, timeZone);
  return {
    seconds: base.seconds * factor,
    milesLeft,
    provider: "ors",
    padded: factor !== 1,
    arrived: false,
  };
}
