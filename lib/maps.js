// Routing + geocoding.
//
// THE SPLIT: distance comes from a truck-legal router, speed comes from a
// traffic-aware one. Neither provider can do both jobs well, and picking one
// outright was wrong in both directions.
//
//   ORS driving-hgv  -> the PATH and its DISTANCE, with dry-van height/weight
//                       restrictions applied, so a 13'6" trailer is never
//                       routed under an 11'8" bridge.
//   Mapbox           -> the SPEED along that corridor: driving-traffic on the
//                       final approach, driving (free-flow) beyond it.
//
//   ETA = truck-legal miles / observed speed, with the speed capped at a
//         governed-truck maximum.
//
// Why not just one of them:
//
// ORS alone is unusable for timing. Measured against this fleet's real rows,
// `driving-hgv` implies ~41 mph on interstates — a 152 mi I-40 run priced at
// 3h38 where the truth is ~2h20. Across four independent loads it landed
// between 35 and 43 mph regardless of route. Worse, the old code multiplied
// that by a 1.15 "traffic padding" factor on the assumption the base was
// optimistic; it was the opposite, so the errors compounded to ~1.8x.
//
// Mapbox alone is unusable for the path. Its `driving` profile is a car: it
// does not know about low clearances, weight limits or truck-prohibited
// parkways. For dry vans in the Northeast that is not a rounding error — the
// legal route around a restricted parkway can be materially longer, and an ETA
// built on the car distance is optimistic in exactly the region where being
// wrong costs the most.
//
// So we buy each provider only for what it is actually good at. Cost is
// unchanged in practice: ORS is free (2,000/day), Mapbox Directions is free
// below 100,000/month, and running both on every check is ~8,200 Mapbox calls
// and ~8,200 ORS calls a month. Caps in usage.js are the hard backstop.

import { bumpUsage, underCap, nominatimGate } from "./usage";

const ORS_BASE = "https://api.heigit.org/openrouteservice";
const ORS_GEOCODE_BASE = "https://api.heigit.org/pelias/v1";
const MAPBOX_BASE = "https://api.mapbox.com/directions/v5/mapbox";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const METERS_PER_MILE = 1609.344;

// Inside this radius we ask for traffic-aware timing.
const CLOSE_MILES = Number(process.env.CLOSE_IN_MILES || 100);
// Straight-line can only ever be shorter than road distance, so anything beyond
// this is guaranteed to be outside CLOSE_MILES — lets us pick a profile before
// spending a routing call.
const DEFINITELY_FAR_MILES = CLOSE_MILES * 1.2;

// ---- ORS timing calibration ---------------------------------------------
//
// Used when ORS has to supply the timing as well as the path (Mapbox down or
// capped). Two independent corrections, and we take whichever is SLOWER so
// neither can produce a reckless ETA on its own:
//
//   1. ORS_CALIBRATION scales the raw duration. 1.55 maps the measured ~41 mph
//      onto ~64 mph.
//   2. ORS_MAX_AVG_MPH is a hard ceiling on implied average speed. This is what
//      keeps the correction honest on short urban legs, where ORS's slowness is
//      genuine congestion rather than profile error — scaling those by 1.55
//      alone would invent a truck doing 35 mph through a city centre.
//
// On a 152 mi interstate leg the two agree almost exactly (64.9 vs 65.0 mph).
const ORS_CALIBRATION = Number(process.env.ORS_CALIBRATION || 1.55);
// Also applied to Mapbox-derived speeds: a car's free-flow pace on a rural
// interstate is ~69 mph, which no governed dry van will hold.
const ORS_MAX_AVG_MPH = Number(process.env.ORS_MAX_AVG_MPH || 65);

// ---- Dry van dimensions (metric, as ORS requires) -----------------------
//
// This is what actually keeps a trailer out from under a low bridge. Without
// `vehicle_type` AND `restrictions`, ORS's driving-hgv applies only generic
// lorry assumptions and will happily route under an 11'8" clearance.
//
// Defaults describe a standard 53' dry van at legal max gross:
//   height   13'6"      = 4.11 m      weight  80,000 lb = 36.29 t
//   width    102"       = 2.60 m      axle    20,000 lb =  9.07 t
//   length   ~73' combined = 22.25 m
//
// Overridable for operators running different equipment. Set VEHICLE_HEIGHT_M
// higher at your peril — it is the one that bridges care about.
const VEHICLE = {
  height: Number(process.env.VEHICLE_HEIGHT_M || 4.11),
  width: Number(process.env.VEHICLE_WIDTH_M || 2.6),
  length: Number(process.env.VEHICLE_LENGTH_M || 22.25),
  weight: Number(process.env.VEHICLE_WEIGHT_T || 36.29),
  axleload: Number(process.env.VEHICLE_AXLELOAD_T || 9.07),
};

// Straight-line distance under which a stop counts as Arrived.
//
// 0.1 mi = 528 ft. Tight enough that "arrived" means at the facility rather
// than merely near it, and well outside Samsara's GPS error (~5-10 m), so the
// noise floor is not the limiting factor.
//
// The trade-off runs the other way though: a truck parked at the back of a
// large DC yard, or staged on the street outside, can legitimately sit 0.2-0.5
// mi from the geocoded pin and never flip to Arrived on distance alone. When
// that happens the check-in tick is the completion signal instead.
export const ARRIVAL_MILES = Number(process.env.ARRIVAL_MILES || 0.1);

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

// ---- free-flow padding --------------------------------------------------
//
// Applies ONLY to free-flow estimates (Mapbox `driving`, calibrated ORS). A
// driving-traffic answer already contains live conditions and must never be
// padded — doing so is double-counting.
//
// It covers two things at once: a loaded truck is slower than the car the
// free-flow profile models, and some congestion will be met en route. The old
// values (up to 1.30) were tuned to compensate for an ORS base that was already
// ~1.55x too slow; on a correctly-scaled base they were pure over-estimation.
//
// Deliberately mild. Note the honest limitation: this is evaluated at DEPARTURE
// time and applied to the whole trip, so a 10-hour haul leaving at 08:00 is
// charged the rush-hour factor for all ten hours. That is acceptable only
// because the factor is now small; if it ever grows, this needs to integrate
// over the trip instead.
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
  if (hour >= 22 || hour < 5) return 1.0; // overnight: open road, truck pace ≈ free-flow
  if (isWeekend) return 1.04;
  if ((hour >= 7 && hour < 9) || (hour >= 16 && hour < 19)) return 1.15; // rush
  return 1.08; // ordinary daytime
}

// ---- geocoding ----------------------------------------------------------
//
// Chain: Nominatim (free, strict policy) -> ORS/Pelias (free) -> Google (paid,
// optional). Results are cached per load in the database, so this runs once per
// destination rather than once per check.

/**
 * Geocode a destination, and say how much to trust the answer.
 *
 * Returns { lat, lng, provider, precision, spanMiles } where precision is
 * "point" (rooftop/POI — trustworthy), "street" (a road, possibly miles long)
 * or "area" (a city or postcode centroid).
 *
 * THE FAILURE THIS EXISTS TO PREVENT: asked for "15100 Thornton Rd, Lodi, CA",
 * Nominatim returned the midpoint of Thornton Road — addresstype "road", with a
 * bounding box 3.8 miles tall — and the old code took those coordinates at face
 * value because the response has exactly the same shape as a rooftop match. A
 * truck 2.8 mi from that arbitrary midpoint was then reported as nearly there.
 * A wrong destination is worse than no destination, because it still produces
 * confident-looking miles and ETAs.
 *
 * So each provider is asked how precise its answer is, and a "point" result
 * from a later provider beats a "street" result from an earlier one. Only if
 * every provider is vague do we return the vague answer — flagged, so the row
 * can warn instead of pretending.
 */
export async function geocode(address) {
  if (!address) return null;
  const attempts = [
    ["nominatim", geocodeNominatim],
    ["ors", geocodeOrs],
    ["google", geocodeGoogle],
  ];
  let lastErr = null;
  let best = null;
  const rank = { point: 3, street: 2, area: 1 };

  for (const [provider, fn] of attempts) {
    if (provider === "google" && !process.env.GOOGLE_MAPS_KEY) continue;
    if (provider === "ors" && !process.env.ORS_API_KEY) continue;
    if (!(await underCap(provider))) continue;
    try {
      const hit = await fn(address);
      await bumpUsage(provider);
      if (!hit) continue;
      const scored = { ...hit, provider };
      // Good enough — stop paying for more lookups.
      if (scored.precision === "point") return scored;
      if (!best || rank[scored.precision] > rank[best.precision]) best = scored;
    } catch (e) {
      lastErr = e;
    }
  }
  if (best) return best;
  if (lastErr) throw lastErr;
  return null;
}

// Diagonal of a result's bounding box, in miles. A rooftop is ~0; a road or a
// town is large. This is the single most reliable precision signal, because it
// measures the actual ambiguity rather than trusting a provider's label.
function bboxSpanMiles(bb) {
  if (!Array.isArray(bb) || bb.length < 4) return null;
  const [s, n, w, e] = bb.map(Number);
  if ([s, n, w, e].some((v) => !Number.isFinite(v))) return null;
  return haversineMiles({ lat: s, lng: w }, { lat: n, lng: e });
}

async function geocodeNominatim(address) {
  await nominatimGate();
  const url = new URL(NOMINATIM);
  url.searchParams.set("q", address);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "us");
  // Needed to read back a house_number, which is the clearest signal that this
  // is a real address match rather than the road it sits on.
  url.searchParams.set("addressdetails", "1");
  const res = await fetch(url, {
    headers: {
      // Nominatim's policy REQUIRES an identifying User-Agent with contact info.
      "User-Agent": process.env.NOMINATIM_UA || "TruckOn/2.0 (+https://truckon.site)",
      "Accept-Language": "en-US,en",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Nominatim geocode failed (${res.status})`);
  const j = await res.json();
  const f = Array.isArray(j) ? j[0] : null;
  if (!f) return null;

  const span = bboxSpanMiles(f.boundingbox);
  // addresstype is the provider's own label. "road" is the dangerous one: it
  // means the house number was not found and the coordinates are just a point
  // somewhere along the way.
  const AREA = new Set([
    "city", "town", "village", "hamlet", "county", "state", "postcode",
    "suburb", "neighbourhood", "municipality", "region", "province",
  ]);
  let precision;
  if (f.address?.house_number) precision = "point";
  else if (AREA.has(f.addresstype)) precision = "area";
  else if (f.addresstype === "road" || f.category === "highway") precision = "street";
  else precision = "point"; // building, amenity, shop, industrial, …

  // The label can still flatter the result, so a large footprint demotes it
  // regardless of what the provider called it.
  if (precision === "point" && span != null && span > 0.4) precision = "street";

  return { lat: Number(f.lat), lng: Number(f.lon), precision, spanMiles: span };
}

async function geocodeOrs(address) {
  const url = new URL(`${ORS_GEOCODE_BASE}/search`);
  url.searchParams.set("api_key", orsKey());
  url.searchParams.set("text", address);
  url.searchParams.set("boundary.country", "US");
  url.searchParams.set("size", "1");
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`ORS geocode failed (${res.status})`);
  const j = await res.json();
  const f = j.features?.[0];
  const c = f?.geometry?.coordinates;
  if (!c) return null;
  // Pelias grades its own results: accuracy "point" is a real address match,
  // "centroid" means it fell back to the containing street or locality.
  const p = f.properties || {};
  const precision =
    p.accuracy === "point" || p.layer === "address" || p.layer === "venue"
      ? "point"
      : p.layer === "street"
      ? "street"
      : "area";
  return { lat: c[1], lng: c[0], precision, spanMiles: null };
}

async function geocodeGoogle(address) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", process.env.GOOGLE_MAPS_KEY);
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Google geocode failed (${res.status})`);
  const j = await res.json();
  const r0 = j.results?.[0];
  const loc = r0?.geometry?.location;
  if (!loc) return null;
  // Google states this outright. ROOFTOP and RANGE_INTERPOLATED are real
  // addresses; GEOMETRIC_CENTER is typically a street, APPROXIMATE a locality.
  const lt = r0.geometry.location_type;
  const precision =
    lt === "ROOFTOP" || lt === "RANGE_INTERPOLATED"
      ? "point"
      : lt === "GEOMETRIC_CENTER"
      ? "street"
      : "area";
  const vp = r0.geometry.viewport;
  const span = vp
    ? haversineMiles(
        { lat: vp.southwest.lat, lng: vp.southwest.lng },
        { lat: vp.northeast.lat, lng: vp.northeast.lng }
      )
    : null;
  return { lat: loc.lat, lng: loc.lng, precision, spanMiles: span };
}

// ---- routing ------------------------------------------------------------

function orsKey() {
  const k = process.env.ORS_API_KEY;
  if (!k) throw new Error("Missing ORS_API_KEY env var.");
  return k;
}

// Truck-legal free-flow route. Returns { seconds, meters } as ORS reports them,
// UNCALIBRATED — callers must pass the result through calibrateOrs().
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
      // `vehicle_type` is not decoration: ORS only consults the restriction
      // values when it knows what kind of vehicle they belong to. Sending
      // `restrictions` without it silently gets you a generic lorry route,
      // which is how a 13'6" trailer ends up under an 11'8" bridge.
      options: {
        vehicle_type: "hgv",
        profile_params: { restrictions: { ...VEHICLE } },
      },
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

/**
 * Correct an ORS driving-hgv result toward reality.
 *
 * Takes the slower of the scaled duration and the speed ceiling, so a bad
 * calibration constant can only ever make the ETA more conservative, never
 * dangerously fast. Returns seconds.
 */
export function calibrateOrs(seconds, meters) {
  const scaled = seconds / (ORS_CALIBRATION > 0 ? ORS_CALIBRATION : 1);
  if (meters == null || !(ORS_MAX_AVG_MPH > 0)) return scaled;
  const floorSeconds = (meters / METERS_PER_MILE / ORS_MAX_AVG_MPH) * 3600;
  return Math.max(scaled, floorSeconds);
}

// Mapbox Directions. `profile` is "driving-traffic" (live conditions, used on
// the final approach) or "driving" (free-flow, used for the far field).
// Both bill against the same 100,000/month free tier.
async function routeMapbox(origin, dest, profile = "driving-traffic") {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error("Missing MAPBOX_TOKEN env var.");
  const coords = `${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
  const url = new URL(`${MAPBOX_BASE}/${profile}/${coords}`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("overview", "false");
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Mapbox directions failed (${res.status})`);
  const j = await res.json();
  const r = j.routes?.[0];
  if (!r || typeof r.duration !== "number") throw new Error("No route found to destination.");
  return { seconds: r.duration, meters: r.distance ?? null };
}

async function routeGoogle(origin, dest) {
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", `${origin.lat},${origin.lng}`);
  url.searchParams.set("destination", `${dest.lat},${dest.lng}`);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("key", process.env.GOOGLE_MAPS_KEY);
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Google Directions failed (${response.status}).`);
  const result = await response.json();
  const leg = result.routes?.[0]?.legs?.[0];
  if (result.status !== "OK" || !leg) {
    throw new Error(`Google Directions returned ${result.status || "no route"}.`);
  }
  return { seconds: leg.duration?.value, meters: leg.distance?.value };
}

function plausibleRoute(meters, straightMiles) {
  if (typeof meters !== "number" || !Number.isFinite(meters) || meters <= 0) return false;
  if (straightMiles == null) return true;
  const routeMiles = meters / METERS_PER_MILE;
  return (
    routeMiles >= straightMiles * 0.9 &&
    routeMiles <= Math.max(straightMiles * 3, straightMiles + 100)
  );
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
    return {
      seconds: 0,
      milesLeft: straight,
      provider: "haversine",
      padded: false,
      arrived: true,
      truckLegal: true,
    };
  }

  // ---- 1. the truck-legal path ----
  let legal = null;
  let orsErr = null;
  if (await underCap("ors")) {
    try {
      legal = await routeOrs(origin, dest);
      await bumpUsage("ors");
      if (!plausibleRoute(legal.meters, straight)) {
        orsErr = new Error("The truck route distance failed a straight-line plausibility check.");
        legal = null;
      }
    } catch (e) {
      orsErr = e;
    }
  }

  // Straight-line under-reads road distance, so a crow-flies distance well past
  // CLOSE_MILES is a safe "definitely far" without spending a call to find out.
  const legalMiles = legal?.meters != null ? legal.meters / METERS_PER_MILE : straight;
  const closeIn =
    !(straight != null && straight > DEFINITELY_FAR_MILES) &&
    legalMiles != null &&
    legalMiles <= CLOSE_MILES;

  // ---- 2. the speed along it ----
  // driving-traffic on the final approach, where congestion is the whole story
  // and will not have changed by the time the truck gets there; free-flow
  // beyond it, where live traffic is precision we cannot actually use.
  if (process.env.MAPBOX_TOKEN && (await underCap("mapbox"))) {
    const profile = closeIn ? "driving-traffic" : "driving";
    try {
      const mb = await routeMapbox(origin, dest, profile);
      await bumpUsage("mapbox");

      if (plausibleRoute(mb.meters, straight) && mb.seconds > 0) {
        const observedMph = mb.meters / METERS_PER_MILE / (mb.seconds / 3600);
        // Cap at the governed-truck maximum: Mapbox is pricing a car, and a
        // loaded dry van will not hold 69 mph just because a sedan can.
        const mph = Math.min(observedMph, ORS_MAX_AVG_MPH);

        // Prefer the truck-legal distance; only when ORS gave us nothing do we
        // fall back to Mapbox's road distance. Note this must NOT fall back to
        // `legalMiles`, which is itself a crow-flies fallback when ORS failed —
        // straight-line under-reads road distance badly enough to make the ETA
        // meaningfully optimistic exactly when a provider is already down.
        const miles = legal ? legalMiles : mb.meters / METERS_PER_MILE;

        if (mph > 0 && miles != null) {
          // The distance is the truck-legal one; only the pace is borrowed.
          // When ORS gave us a detour around a restriction, that detour is
          // still in the mileage — which is the entire point.
          const seconds = (miles / mph) * 3600;
          // A traffic answer already contains the congestion; padding it would
          // count the same delay twice.
          const factor = closeIn ? 1 : paddingFactor(now, timeZone);
          return {
            seconds: seconds * factor,
            milesLeft: miles,
            provider: legal ? (closeIn ? "hgv+traffic" : "hgv+flow") : closeIn ? "traffic" : "flow",
            padded: factor !== 1,
            arrived: false,
            // False means the mileage came from a car router — the ETA is still
            // usable, but the route may not be one a 13'6" trailer can take.
            truckLegal: !!legal,
          };
        }
      }
    } catch {
      // fall through to ORS's own timing rather than failing the check
    }
  }

  // Anomalous or unavailable primary routes get one independent check against
  // Google Directions when an account key is configured. This is deliberately
  // a fallback only; Google routes are car routes, not truck-legal routes.
  if (!legal && process.env.GOOGLE_MAPS_KEY && (await underCap("google"))) {
    try {
      const google = await routeGoogle(origin, dest);
      await bumpUsage("google");
      if (!plausibleRoute(google.meters, straight) || !(google.seconds > 0)) {
        throw new Error("Google Directions distance also failed the plausibility check.");
      }
      const miles = google.meters / METERS_PER_MILE;
      const carMph = google.meters / METERS_PER_MILE / (google.seconds / 3600);
      const mph = Math.min(carMph, ORS_MAX_AVG_MPH);
      const factor = paddingFactor(now, timeZone);
      return {
        seconds: (miles / mph) * 3600 * factor,
        milesLeft: miles,
        provider: "google-fallback",
        padded: factor !== 1,
        arrived: false,
        truckLegal: false,
      };
    } catch (e) {
      orsErr = orsErr || e;
    }
  }

  // ---- 3. ORS supplies the timing too (Mapbox down or capped) ----
  if (!legal) throw orsErr || new Error("No routing provider available.");

  const factor = paddingFactor(now, timeZone);
  return {
    seconds: calibrateOrs(legal.seconds, legal.meters) * factor,
    milesLeft: legalMiles,
    provider: "hgv",
    padded: factor !== 1,
    arrived: false,
    truckLegal: true,
  };
}
