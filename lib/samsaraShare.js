// Samsara Live Share reader.
//
// Replaces the old headless-Chromium scraper. The share page is a GraphQL SPA:
// all of its content comes from one POST, and the WebSocket it opens only
// pushes {"computation":{"invalidated":true}} as a "something changed" bell.
// So we skip the browser entirely and call the endpoint ourselves.
//
// Two steps, both plain HTTP, verified working ANONYMOUSLY (incognito, signed out):
//
//   1. GET  https://cloud.samsara.com/o/{orgId}/fleet/viewer/{token}
//           -> mints an anonymous `samsara-session` cookie + a CSRF token,
//              and tells us which API shard the org lives on.
//   2. POST https://{shard}/r/graphql?q=FleetViewer
//           Accept: application/json; version=2
//           Origin: https://cloud.samsara.com
//           Cookie / X-Csrf-Token from step 1.
//
// Sessions are cached per token so step 1 runs rarely, not on every check.

const PAGE_ORIGIN = "https://cloud.samsara.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

// Sent verbatim as captured from the real client. Deliberately NOT trimmed to
// just the fields we read: matching the browser byte-for-byte is the cheapest
// insurance against server-side query allow-listing or persisted-query hashing.
const FLEET_VIEWER_QUERY = `query FleetViewer($token: string!, $duration: int64!) {
  fleetViewerToken(token: $token) {
    ...FleetViewerInfo
  }
}

fragment FleetViewerInfo on FleetViewerToken {
  description
  devices(feature: "fleetTrackable") {
    ...FleetViewerDevice
  }
  destinationName
  destinationAddress: address
  destinationLatitude: latitude
  destinationLongitude: longitude
  group {
    id
  }
  organization {
    name
    logoType
    logoDomain
    logoS3Location
  }
}

fragment FleetViewerDevice on Device {
  name
  id
  orgId
  location: fleetViewerLocation(duration: $duration) {
    time
    latitude
    longitude
    heading
    speed
    formatted
    locationSource
    accuracyMillimeters
  }
  engineState: objectStat(statTypeEnum: osDEngineState, duration: $duration) {
    time: changedAtMs
    value: intValue
  }
  isAsset: hasFeature(featureKey: freight)
  deviceCable {
    powerStatusEvents(invalidateIfStale: true) {
      isOn
    }
  }
  currentDriver {
    id
    name
  }
  tagMapMarkerColor
  unpoweredDormantSince: objectStat(statTypeEnum: osDUnpoweredDormantSinceMs, duration: $duration) {
    value: intValue
  }
  isCruxPeripheralOnly: hasFeature(featureKey: crux_peripheral_only)
}
`;

export function looksLikeShareUrl(s) {
  return /^https?:\/\//i.test(String(s || "").trim());
}

// "https://cloud.samsara.com/o/18379/fleet/viewer/vGPccXwx1gfgFSCEYEiC"
//   -> { orgId: "18379", token: "vGPccXwx1gfgFSCEYEiC" }
export function parseShareUrl(url) {
  try {
    const u = new URL(String(url).trim());
    if (!/(^|\.)samsara\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/o\/(\d+)\/fleet\/viewer\/([A-Za-z0-9_-]+)/);
    if (!m) return null;
    return { orgId: m[1], token: m[2], href: u.href };
  } catch {
    return null;
  }
}

// ---- session bootstrap -------------------------------------------------

// token -> { cookie, csrf, shard, at }
const sessions = new Map();
const SESSION_TTL_MS = 20 * 60 * 1000;

function pickSetCookies(res) {
  // Node 18+/undici exposes getSetCookie(); fall back to the raw header.
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const raw = res.headers.get("set-cookie");
  return raw ? [raw] : [];
}

// Forward every cookie the origin set. An earlier version filtered to an
// allow-list of names and that was a mistake: it silently dropped whatever
// session cookie Samsara actually issues, producing a 401 with no clue why.
// These are our own server's anonymous cookies for a public link, so there is
// nothing sensitive to withhold.
function cookieHeaderFrom(setCookies) {
  const seen = new Map();
  for (const c of setCookies) {
    const pair = String(c).split(";")[0].trim();
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const name = pair.slice(0, eq);
    if (!pair.slice(eq + 1)) continue; // skip deletions (name=)
    seen.set(name, pair);
  }
  return [...seen.values()].join("; ");
}

function findCsrf(html, setCookies) {
  // 1) a CSRF cookie (double-submit pattern) — any plausible name
  for (const c of setCookies) {
    const m = String(c).match(/^([^=]*(?:csrf|xsrf)[^=]*)=([^;]+)/i);
    if (m && m[2]) return decodeURIComponent(m[2]);
  }
  // 2) embedded in the document. The share page is a JS shell, so this usually
  // finds nothing — kept because it's free and some deploys do inline it.
  const patterns = [
    /<meta[^>]+name=["'](?:csrf-token|_csrf)["'][^>]+content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i,
    /["'](?:csrfToken|csrf_token|csrf|xsrfToken)["']\s*:\s*["']([^"']{8,})["']/i,
    /window\.__(?:CSRF|csrf)__\s*=\s*["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

// The org's API lives on a shard (us4-ws, eu1-ws, ...). Read it from the page
// rather than hardcoding `us4`, since other carriers' links may resolve elsewhere.
function findShard(html) {
  const m = html.match(/https:\/\/((?:[a-z]{2}\d+)(?:-ws)?\.cloud\.samsara\.com)/i);
  return m ? m[1] : null;
}

async function bootstrap(orgId, token, { timeoutMs = 15000 } = {}) {
  const cached = sessions.get(token);
  if (cached && Date.now() - cached.at < SESSION_TTL_MS) return cached;

  const url = `${PAGE_ORIGIN}/o/${orgId}/fleet/viewer/${token}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Share page returned ${res.status} (link expired or revoked?)`);
  }
  const html = await res.text();
  const setCookies = pickSetCookies(res);

  const session = {
    cookie: cookieHeaderFrom(setCookies),
    csrf: findCsrf(html, setCookies),
    // Prefer the shard advertised by the page; fall back to the common US one.
    shard: findShard(html) || "us4-ws.cloud.samsara.com",
    at: Date.now(),
  };
  sessions.set(token, session);
  return session;
}

// ---- main entry point --------------------------------------------------

function normalizeDevice(dev, tokenInfo) {
  // `location` is a short history window; the newest fix is last.
  const locs = Array.isArray(dev?.location) ? dev.location : [];
  const last = locs.length ? locs[locs.length - 1] : null;
  if (!last || typeof last.latitude !== "number" || typeof last.longitude !== "number") {
    return null;
  }
  const destLat = tokenInfo?.destinationLatitude;
  const destLng = tokenInfo?.destinationLongitude;
  // Location-only links report 0/0 and empty strings rather than null.
  const hasDestination =
    typeof destLat === "number" &&
    typeof destLng === "number" &&
    (destLat !== 0 || destLng !== 0);

  return {
    truckName: dev.name || tokenInfo?.description || null,
    lat: last.latitude,
    lng: last.longitude,
    // Ready-to-display place string — saves a reverse-geocode on every check.
    formatted: last.formatted || null,
    speed: typeof last.speed === "number" ? last.speed : null,
    heading: typeof last.heading === "number" ? last.heading : null,
    fixTimeMs: typeof last.time === "number" ? last.time : null,
    accuracyMeters:
      typeof last.accuracyMillimeters === "number"
        ? last.accuracyMillimeters / 1000
        : null,
    locationSource: last.locationSource || null,
    hasDestination,
    destName: tokenInfo?.destinationName || null,
    destAddress: tokenInfo?.destinationAddress || null,
    destLat: hasDestination ? destLat : null,
    destLng: hasDestination ? destLng : null,
  };
}

// Read one Live Share link. Returns the normalized shape above, or throws.
// `retryOnAuthFail` re-bootstraps once if a cached session went stale.
export async function fetchShareLocation(shareUrl, { timeoutMs = 15000 } = {}) {
  const parsed = parseShareUrl(shareUrl);
  if (!parsed) throw new Error("Not a recognizable Samsara Live Share link.");
  const { orgId, token } = parsed;

  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await bootstrap(orgId, token, { timeoutMs });

    const headers = {
      "User-Agent": UA,
      Accept: "application/json; version=2",
      "Content-Type": "application/json",
      Origin: PAGE_ORIGIN,
      Referer: `${PAGE_ORIGIN}/o/${orgId}/fleet/viewer/${token}`,
    };
    if (session.cookie) headers.Cookie = session.cookie;
    if (session.csrf) headers["X-Csrf-Token"] = session.csrf;

    const res = await fetch(`https://${session.shard}/r/graphql?q=FleetViewer`, {
      method: "POST",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        extensions: {
          route: "/o/:org_id/fleet/viewer/:token",
          orgId,
          stashOutput: true,
          storeDepSet: true,
        },
        query: FLEET_VIEWER_QUERY,
        variables: { token, duration: 30000 },
      }),
    });

    // A stale cached session is the most likely cause of a 401/403 — drop it
    // and bootstrap fresh once before giving up.
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      sessions.delete(token);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Samsara GraphQL returned ${res.status}`);
    }

    const json = await res.json().catch(() => null);
    if (json?.errors?.length) {
      throw new Error(
        `Samsara GraphQL error: ${String(json.errors[0]?.message).slice(0, 160)}`
      );
    }
    const tokenInfo = json?.data?.fleetViewerToken;
    if (!tokenInfo) throw new Error("Share link returned no data (expired?).");

    const devices = Array.isArray(tokenInfo.devices) ? tokenInfo.devices : [];
    for (const dev of devices) {
      const norm = normalizeDevice(dev, tokenInfo);
      if (norm) return norm;
    }
    throw new Error("Share link has no recent GPS fix.");
  }
  throw new Error("Samsara rejected the share session twice.");
}

/**
 * Diagnostics for the admin debug endpoint.
 *
 * The bootstrap can only be observed from a server — a browser can't reproduce
 * it because of cookie scoping across cloud.* and us4-ws.*. This reports exactly
 * what our server sees so a 401 can be diagnosed from evidence instead of guessed at.
 * Returns no secret values, only names, lengths and status codes.
 */
export async function debugShare(shareUrl) {
  const parsed = parseShareUrl(shareUrl);
  if (!parsed) return { ok: false, stage: "parse", error: "Unrecognized share URL" };
  const { orgId, token } = parsed;
  const out = { ok: false, orgId, tokenLength: token.length };

  const pageUrl = `${PAGE_ORIGIN}/o/${orgId}/fleet/viewer/${token}`;
  let res;
  try {
    res = await fetch(pageUrl, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return { ...out, stage: "page-fetch", error: e.message };
  }

  const html = await res.text().catch(() => "");
  const setCookies = pickSetCookies(res);
  const cookie = cookieHeaderFrom(setCookies);
  const csrf = findCsrf(html, setCookies);
  const shard = findShard(html);

  out.page = {
    status: res.status,
    finalUrl: res.url,
    htmlLength: html.length,
    setCookieCount: setCookies.length,
    cookieNames: setCookies
      .map((c) => String(c).split("=")[0].trim())
      .filter(Boolean),
    csrfFound: !!csrf,
    csrfLength: csrf ? csrf.length : 0,
    shardFound: shard,
    // Which hostnames the shell references, to confirm shard detection.
    hostsInHtml: [...new Set((html.match(/[a-z0-9-]+\.cloud\.samsara\.com/gi) || []))].slice(0, 8),
  };

  const headers = {
    "User-Agent": UA,
    Accept: "application/json; version=2",
    "Content-Type": "application/json",
    Origin: PAGE_ORIGIN,
    Referer: pageUrl,
  };
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers["X-Csrf-Token"] = csrf;

  const body = JSON.stringify({
    extensions: { route: "/o/:org_id/fleet/viewer/:token", orgId, stashOutput: true, storeDepSet: true },
    query: FLEET_VIEWER_QUERY,
    variables: { token, duration: 30000 },
  });

  const host = shard || "us4-ws.cloud.samsara.com";
  try {
    const g = await fetch(`https://${host}/r/graphql?q=FleetViewer`, {
      method: "POST",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      body,
    });
    const text = await g.text().catch(() => "");
    out.graphql = {
      host,
      status: g.status,
      sentCookie: !!cookie,
      sentCsrf: !!csrf,
      // First slice of the body usually names the exact complaint.
      bodyPreview: text.slice(0, 400),
    };
    out.ok = g.ok;
  } catch (e) {
    out.graphql = { host, error: e.message };
  }
  return out;
}

// Exported for tests.
export const __internals = { findCsrf, findShard, cookieHeaderFrom, normalizeDevice };
