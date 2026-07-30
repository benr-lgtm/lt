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
