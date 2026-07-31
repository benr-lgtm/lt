// Samsara official API client (read-only) + time helpers.
// Docs: https://developers.samsara.com/reference

import tzlookup from "tz-lookup";

const SAMSARA_BASE = process.env.SAMSARA_BASE_URL || "https://api.samsara.com";

// IANA timezone for a lat/lng (offline lookup). Null if it can't be resolved.
export function tzFromCoords(lat, lng) {
  try {
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    return tzlookup(lat, lng);
  } catch {
    return null;
  }
}

// Supports one or more Samsara accounts.
//
// Multi-tenant note: truck# mode resolves a truck NAME against a fleet, so it
// is only meaningful within one carrier's account. Each user therefore brings
// their own token (stored per-profile); the env vars below are the instance
// owner's fallback. Never let one user's truck number match another's fleet —
// pass that user's tokens explicitly.
function getTokens(extra = []) {
  const list = [];
  for (const t of extra) {
    const v = String(t || "").trim();
    if (v) list.push(v);
  }
  if (process.env.SAMSARA_API_TOKEN) list.push(process.env.SAMSARA_API_TOKEN);
  if (process.env.SAMSARA_API_TOKENS) {
    for (const t of process.env.SAMSARA_API_TOKENS.split(",")) {
      const v = t.trim();
      if (v) list.push(v);
    }
  }
  return [...new Set(list)];
}

export function hasSamsaraToken(extra = []) {
  return getTokens(extra).length > 0;
}

async function fetchGpsForToken(token, map) {
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${SAMSARA_BASE}/fleet/vehicles/stats`);
    url.searchParams.set("types", "gps");
    if (cursor) url.searchParams.set("after", cursor);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Samsara GPS request failed (${res.status}): ${body.slice(0, 200)}`
      );
    }
    const json = await res.json();
    for (const v of json.data || []) {
      const gps = Array.isArray(v.gps) ? v.gps[v.gps.length - 1] : v.gps;
      if (!gps) continue;
      const lat = gps.latitude ?? gps.lat;
      const lng = gps.longitude ?? gps.lng;
      if (typeof lat !== "number" || typeof lng !== "number") continue;
      const key = normalizeTruck(v.name);
      if (!map.has(key)) {
        map.set(key, {
          lat,
          lng,
          formatted: gps.reverseGeo?.formattedLocation || null,
          time: gps.time || null,
          // Already in the payload we were fetching and previously thrown away.
          // Distance alone cannot tell a truck parked in a DC yard from one
          // driving past on the road outside; speed can. Null (rather than 0)
          // when absent, so "unknown speed" is never mistaken for "stopped".
          speed:
            typeof gps.speedMilesPerHour === "number" ? gps.speedMilesPerHour : null,
          // Needed to ask for this vehicle's history later; the history
          // endpoint takes ids, not names.
          id: v.id,
          name: v.name,
        });
      }
    }
    if (json.pagination?.hasNextPage && json.pagination?.endCursor) {
      cursor = json.pagination.endCursor;
    } else {
      break;
    }
  }
}

// Fetch every vehicle's latest GPS across all configured Samsara accounts.
// Returns a Map keyed by normalized vehicle name -> { lat, lng, formatted, time, name }.
// `errors` (optional array) collects per-token failures without aborting the rest.
export async function getVehicleGpsByName(errors = [], extraTokens = []) {
  const tokens = getTokens(extraTokens);
  if (tokens.length === 0) throw new Error("No Samsara API token configured.");
  const map = new Map();
  for (let i = 0; i < tokens.length; i++) {
    try {
      await fetchGpsForToken(tokens[i], map);
    } catch (e) {
      errors.push(`token #${i + 1}: ${e.message}`);
    }
  }
  return map;
}

/**
 * Did this vehicle stop near `dest` during [sinceMs, now]?
 *
 * Everything else in this app is SAMPLED: the cron looks at where a truck is
 * right now, every few minutes to a few hours depending on slack. A stop that
 * begins and ends between two samples is invisible — a 90-minute delivery on a
 * load with 6 hours of buffer (checked every 3 hours) can be missed entirely,
 * and the row then runs on to its deadline looking un-delivered.
 *
 * History turns arrival from something you must be watching for into something
 * you can confirm afterwards. One call replays the breadcrumbs and answers a
 * question the live checks cannot: was it parked there at any point?
 *
 * Returns { arrivedAt, minutes, miles } for the longest qualifying stop, or
 * null. Costs ONE call per vehicle, so callers must gate it — see
 * historyBackfill() in app/api/check/route.js.
 */
export async function findStopNear(
  vehicleId,
  dest,
  { sinceMs, nearMiles = 0.5, dwellMinutes = 15, extraTokens = [] } = {}
) {
  if (!vehicleId || !dest) return null;
  const tokens = getTokens(extraTokens);
  if (!tokens.length) return null;

  const startTime = new Date(sinceMs).toISOString();
  const endTime = new Date().toISOString();

  for (const token of tokens) {
    let cursor = null;
    const points = [];
    try {
      for (let page = 0; page < 10; page++) {
        const url = new URL(`${SAMSARA_BASE}/fleet/vehicles/stats/history`);
        url.searchParams.set("types", "gps");
        url.searchParams.set("vehicleIds", String(vehicleId));
        url.searchParams.set("startTime", startTime);
        url.searchParams.set("endTime", endTime);
        if (cursor) url.searchParams.set("after", cursor);

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(20000),
        });
        // A token that doesn't own this vehicle 404s; try the next account.
        if (!res.ok) break;
        const json = await res.json();
        for (const v of json.data || []) {
          for (const g of v.gps || []) {
            const lat = g.latitude ?? g.lat;
            const lng = g.longitude ?? g.lng;
            if (typeof lat !== "number" || typeof lng !== "number") continue;
            points.push({ t: Date.parse(g.time), lat, lng });
          }
        }
        if (json.pagination?.hasNextPage && json.pagination?.endCursor) {
          cursor = json.pagination.endCursor;
        } else break;
      }
    } catch {
      continue; // this account failed; try the next
    }
    if (!points.length) continue;
    points.sort((a, b) => a.t - b.t);

    // Longest unbroken run of breadcrumbs inside the radius. Distance alone is
    // the test here, not speed: a sequence of fixes that all sit within a few
    // hundred yards for twenty minutes IS a stop, whatever the reported speed.
    let best = null;
    let runStart = null;
    let closest = Infinity;
    const R = 3958.7613;
    const near = (p) => {
      const toRad = (d) => (d * Math.PI) / 180;
      const dLat = toRad(dest.lat - p.lat);
      const dLng = toRad(dest.lng - p.lng);
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(p.lat)) * Math.cos(toRad(dest.lat)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    for (const p of points) {
      const d = near(p);
      if (d <= nearMiles) {
        if (runStart == null) {
          runStart = p.t;
          closest = d;
        }
        closest = Math.min(closest, d);
        const minutes = (p.t - runStart) / 60000;
        if (minutes >= dwellMinutes && (!best || minutes > best.minutes)) {
          best = { arrivedAt: new Date(runStart).toISOString(), minutes, miles: closest };
        }
      } else {
        runStart = null;
        closest = Infinity;
      }
    }
    if (best) return best;
  }
  return null;
}

// Normalize a truck number / vehicle name for matching.
// "  #7134 " and "7134" and "7134 " all become "7134".
export function normalizeTruck(s) {
  return String(s || "")
    .trim()
    .replace(/^#/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// ---- Time helpers -------------------------------------------------

// UTC offset (minutes) of an IANA timezone at a given instant. Handles DST.
export function tzOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = dtf
    .formatToParts(date)
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  const hour = p.hour === "24" ? "00" : p.hour;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}

// Interpret a datetime-local string ("2026-07-19T06:00") as wall-clock time
// in `timeZone`, returning an absolute ISO string. Null if unparseable.
export function localToIso(deadlineLocal, timeZone) {
  const m = String(deadlineLocal || "").match(
    /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/
  );
  if (!m) return null;
  const [, Y, M, D, h, mi] = m.map(Number);
  const ts = Date.UTC(Y, M - 1, D, h, mi);
  let off = tzOffsetMinutes(new Date(ts), timeZone);
  let utc = ts - off * 60000;
  off = tzOffsetMinutes(new Date(utc), timeZone); // refine across DST edges
  utc = ts - off * 60000;
  return new Date(utc).toISOString();
}

// Format an absolute ISO time as a readable string in a timezone,
// e.g. "6:15 AM CDT".
export function formatEta(iso, timeZone) {
  if (!iso) return null;
  try {
    // Date included, not just the clock time: a bare "3:54 AM" on a multi-day
    // run is ambiguous about WHICH morning, which is the one thing a dispatcher
    // must not have to guess. Kept to "Jul 31" (no weekday, no year) so it still
    // fits the Status column.
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString();
  }
}
