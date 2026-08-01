// Samsara Live Share reader.
//
// The share page is a GraphQL SPA. We skip the browser and call the endpoint
// ourselves. Two steps, both plain HTTP, verified working ANONYMOUSLY
// (incognito, signed out) against a real share link:
//
//   1. GET  https://cloud.samsara.com/r/auth/csrf
//           -> {"csrf_token": "<16 chars>"} plus the anonymous session cookie.
//   2. POST https://cloud.samsara.com/r/graphql?q=FleetViewer
//           Accept: application/json; version=2
//           Origin: https://cloud.samsara.com
//           Cookie + X-Csrf-Token from step 1.
//
// Sessions are cached so step 1 runs rarely, not on every check.
//
// HISTORY — why this used to 401 with the body `csrf`:
// The previous version bootstrapped by GETting the share page itself, on the
// assumption that the page minted the session cookie and embedded a CSRF token.
// That is not true: the share page is a static shell served from CloudFront. It
// sets no cookies and contains no token, so we sent the POST with an empty
// Cookie header and no X-Csrf-Token, and the API answered `401 csrf`. The token
// comes from the dedicated /r/auth/csrf endpoint, never from the page.
//
// It also tried to guess an API "shard" (us4-ws, eu1-ws...) by scraping
// hostnames out of that page. The only host in there is the CDN's
// static.cloud.samsara.com, so the scrape always failed and every org silently
// fell back to a hardcoded us4-ws — correct for US orgs by luck, wrong for EU.
// The main origin routes to the right shard on its own, so there is nothing to
// guess and the shard logic is gone.

const PAGE_ORIGIN = "https://cloud.samsara.com";

// Both auth and GraphQL live here. cloud.samsara.com routes to whichever shard
// the org actually lives on, so this works for US and EU orgs alike.
const API_ORIGIN = "https://cloud.samsara.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

// Trimmed to exactly the fields normalizeDevice() reads, and verified end-to-end
// against a live anonymous share link. The old version sent the client's full
// query verbatim (engine state, driver, cable power, tag colours...) on the
// theory that matching the browser byte-for-byte guarded against query
// allow-listing. There is no allow-listing — arbitrary queries are accepted —
// and every extra field was a chance to break on a schema change we don't care
// about.
const FLEET_VIEWER_QUERY = `query FleetViewer($token: string!, $duration: int64!) {
  fleetViewerToken(token: $token) {
    description
    devices(feature: "fleetTrackable") {
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
    }
    destinationName
    destinationAddress: address
    destinationLatitude: latitude
    destinationLongitude: longitude
  }
}
`;

// URL recognition moved to lib/shareLink.js so the browser can run the same
// check without pulling this whole network reader into the client bundle.
// Re-exported here so existing importers keep working.
export { looksLikeShareUrl, parseShareUrl } from "./shareLink";
import { parseShareUrl } from "./shareLink";

// ---- session bootstrap -------------------------------------------------

// The anonymous session is per-origin, not per-link, so one cached session
// serves every share link we read. (The old code keyed this by share token,
// which meant re-bootstrapping for each load on every sweep.)
let session = null; // { cookie, csrf, at }
const SESSION_TTL_MS = 20 * 60 * 1000;

function pickSetCookies(res) {
  // Node 18+/undici exposes getSetCookie(); fall back to the raw header.
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const raw = res.headers.get("set-cookie");
  return raw ? [raw] : [];
}

// Forward every cookie the origin set, rather than an allow-list of names we
// think we recognise — Samsara is free to rename its session cookie, and
// dropping it would resurface exactly the 401 this module used to return.
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

// Merge a fresh batch of Set-Cookie headers into an existing Cookie string, so
// cookies the API hands back mid-flight aren't lost on the next request.
function mergeCookies(existing, setCookies) {
  const jar = new Map();
  for (const pair of String(existing || "").split(";")) {
    const p = pair.trim();
    const eq = p.indexOf("=");
    if (eq > 0) jar.set(p.slice(0, eq), p);
  }
  for (const pair of String(cookieHeaderFrom(setCookies) || "").split(";")) {
    const p = pair.trim();
    const eq = p.indexOf("=");
    if (eq > 0) jar.set(p.slice(0, eq), p);
  }
  return [...jar.values()].join("; ");
}

// Mint an anonymous session + CSRF token. This endpoint is the ONLY source of
// the token; the share page has neither cookie nor token in it.
async function bootstrap({ timeoutMs = 15000, referer = PAGE_ORIGIN } = {}) {
  if (session && Date.now() - session.at < SESSION_TTL_MS) return session;

  const res = await fetch(`${API_ORIGIN}/r/auth/csrf`, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: referer,
      Origin: PAGE_ORIGIN,
    },
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Samsara auth endpoint returned ${res.status}`);
  }

  const json = await res.json().catch(() => null);
  // Documented shape is {"csrf_token": "..."}; the fallbacks cost nothing and
  // absorb a rename.
  const csrf =
    json?.csrf_token || json?.csrfToken || json?.token || json?.value || null;
  if (!csrf) {
    throw new Error("Samsara auth endpoint returned no CSRF token.");
  }

  session = {
    cookie: mergeCookies("", pickSetCookies(res)),
    csrf,
    at: Date.now(),
  };
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

  const referer = `${PAGE_ORIGIN}/o/${orgId}/fleet/viewer/${token}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await bootstrap({ timeoutMs, referer });

    const headers = {
      "User-Agent": UA,
      Accept: "application/json; version=2",
      "Content-Type": "application/json",
      Origin: PAGE_ORIGIN,
      Referer: referer,
      "X-Csrf-Token": s.csrf,
    };
    if (s.cookie) headers.Cookie = s.cookie;

    const res = await fetch(`${API_ORIGIN}/r/graphql?q=FleetViewer`, {
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

    // Keep any cookie the API rotated back at us.
    if (session) session.cookie = mergeCookies(session.cookie, pickSetCookies(res));

    // A stale cached session is the most likely cause of a 401/403 — drop it
    // and bootstrap fresh once before giving up.
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      session = null;
      continue;
    }
    if (!res.ok) {
      // The body names the actual complaint (e.g. `csrf`). Surfacing it turns a
      // bare status code into something diagnosable from the UI tooltip.
      const why = (await res.text().catch(() => "")).trim().slice(0, 80);
      throw new Error(
        `Samsara GraphQL returned ${res.status}${why ? ` (${why})` : ""}`
      );
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

  // Step 1 — mint an anonymous session + CSRF token.
  let auth, authJson;
  try {
    auth = await fetch(`${API_ORIGIN}/r/auth/csrf`, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Origin: PAGE_ORIGIN,
        Referer: pageUrl,
      },
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    authJson = await auth.json().catch(() => null);
  } catch (e) {
    return { ...out, stage: "auth-fetch", error: e.message };
  }

  const setCookies = pickSetCookies(auth);
  const cookie = mergeCookies("", setCookies);
  const csrf =
    authJson?.csrf_token || authJson?.csrfToken || authJson?.token || null;

  out.auth = {
    status: auth.status,
    setCookieCount: setCookies.length,
    cookieNames: setCookies
      .map((c) => String(c).split("=")[0].trim())
      .filter(Boolean),
    tokenFound: !!csrf,
    tokenLength: csrf ? String(csrf).length : 0,
    jsonKeys: authJson ? Object.keys(authJson) : null,
  };

  if (!csrf) {
    return { ...out, stage: "auth-token", error: "No CSRF token in auth response" };
  }

  // Step 2 — the actual query.
  const headers = {
    "User-Agent": UA,
    Accept: "application/json; version=2",
    "Content-Type": "application/json",
    Origin: PAGE_ORIGIN,
    Referer: pageUrl,
    "X-Csrf-Token": csrf,
  };
  if (cookie) headers.Cookie = cookie;

  try {
    const g = await fetch(`${API_ORIGIN}/r/graphql?q=FleetViewer`, {
      method: "POST",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        extensions: { route: "/o/:org_id/fleet/viewer/:token", orgId, stashOutput: true, storeDepSet: true },
        query: FLEET_VIEWER_QUERY,
        variables: { token, duration: 30000 },
      }),
    });
    const text = await g.text().catch(() => "");
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(text);
    } catch {}
    const dev = parsedBody?.data?.fleetViewerToken?.devices?.[0];
    const loc = Array.isArray(dev?.location) ? dev.location[dev.location.length - 1] : null;

    out.graphql = {
      host: API_ORIGIN,
      status: g.status,
      sentCookie: !!cookie,
      sentCsrf: true,
      deviceCount: parsedBody?.data?.fleetViewerToken?.devices?.length ?? null,
      deviceName: dev?.name ?? null,
      lat: loc?.latitude ?? null,
      lng: loc?.longitude ?? null,
      formatted: loc?.formatted ?? null,
      // First slice of the body usually names the exact complaint.
      bodyPreview: parsedBody ? null : text.slice(0, 400),
    };
    out.ok = g.ok && !!parsedBody?.data?.fleetViewerToken;
  } catch (e) {
    out.graphql = { host: API_ORIGIN, error: e.message };
  }
  return out;
}

// Exported for tests.
export const __internals = { cookieHeaderFrom, mergeCookies, normalizeDevice };
