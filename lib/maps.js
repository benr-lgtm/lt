// Geocoding + driving-ETA via a maps provider.
// Default: Mapbox (generous free tier). Set MAPS_PROVIDER=google to use Google.

const PROVIDER = (process.env.MAPS_PROVIDER || "mapbox").toLowerCase();
// Geocoding can use a different (more forgiving) provider than the ETA engine.
// Geocoding happens once per load and is cached, so Google here is essentially free.
const GEOCODE_PROVIDER = (
  process.env.GEOCODE_PROVIDER || PROVIDER
).toLowerCase();

// Geocode a free-text address -> { lat, lng } or null.
// If the primary geocoder misses and a Google key exists, fall back to Google
// (more tolerant of company names, typos, and suite/dock clutter).
export async function geocode(address) {
  if (!address) return null;
  const primary =
    GEOCODE_PROVIDER === "google" ? geocodeGoogle : geocodeMapbox;
  try {
    const hit = await primary(address);
    if (hit) return hit;
  } catch (e) {
    if (GEOCODE_PROVIDER !== "google" && !process.env.GOOGLE_MAPS_KEY) throw e;
  }
  if (GEOCODE_PROVIDER !== "google" && process.env.GOOGLE_MAPS_KEY) {
    return geocodeGoogle(address);
  }
  return null;
}

// Driving time in seconds from origin to destination (with live traffic).
export async function drivingEtaSeconds(origin, dest) {
  if (PROVIDER === "google") return etaGoogle(origin, dest);
  return etaMapbox(origin, dest);
}

// ---- Mapbox ----
function mapboxToken() {
  const t = process.env.MAPBOX_TOKEN;
  if (!t) throw new Error("Missing MAPBOX_TOKEN env var.");
  return t;
}

async function geocodeMapbox(address) {
  const url = new URL(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
      address
    )}.json`
  );
  url.searchParams.set("access_token", mapboxToken());
  url.searchParams.set("limit", "1");
  url.searchParams.set("country", "us");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox geocode failed (${res.status})`);
  const j = await res.json();
  const f = j.features?.[0];
  if (!f) return null;
  const [lng, lat] = f.center;
  return { lat, lng };
}

async function etaMapbox(origin, dest) {
  const coords = `${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
  const url = new URL(
    `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}`
  );
  url.searchParams.set("access_token", mapboxToken());
  url.searchParams.set("overview", "false");
  url.searchParams.set("annotations", "duration");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox directions failed (${res.status})`);
  const j = await res.json();
  const dur = j.routes?.[0]?.duration;
  if (typeof dur !== "number") throw new Error("No route found to destination.");
  return dur;
}

// ---- Google (optional) ----
function googleKey() {
  const k = process.env.GOOGLE_MAPS_KEY;
  if (!k) throw new Error("Missing GOOGLE_MAPS_KEY env var.");
  return k;
}

async function geocodeGoogle(address) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", googleKey());
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google geocode failed (${res.status})`);
  const j = await res.json();
  const loc = j.results?.[0]?.geometry?.location;
  if (!loc) return null;
  return { lat: loc.lat, lng: loc.lng };
}

async function etaGoogle(origin, dest) {
  const url = new URL(
    "https://maps.googleapis.com/maps/api/distancematrix/json"
  );
  url.searchParams.set("origins", `${origin.lat},${origin.lng}`);
  url.searchParams.set("destinations", `${dest.lat},${dest.lng}`);
  url.searchParams.set("departure_time", "now"); // live traffic
  url.searchParams.set("key", googleKey());
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google distancematrix failed (${res.status})`);
  const j = await res.json();
  const el = j.rows?.[0]?.elements?.[0];
  const dur = el?.duration_in_traffic?.value ?? el?.duration?.value;
  if (typeof dur !== "number") throw new Error("No route found to destination.");
  return dur;
}
