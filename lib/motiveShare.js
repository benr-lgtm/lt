import { parseMotiveUrl } from "./shareLink";

const API_URL = "https://api.keeptruckin.com/api/s1/live_shares";
// Motive embeds this read-only share key in its public tracking page.
const PUBLIC_WEB_SHARE_KEY =
  "3gCAa2VxLV3nlJfk7EhzJUEe5lg3IU9b50sNyOfUSSE6Fg2ACZr6GK5KqpMW55rn";

export async function fetchMotiveLocation(shareUrl, { timeoutMs = 15000 } = {}) {
  const parsed = parseMotiveUrl(shareUrl);
  if (!parsed) throw new Error("Not a recognizable Motive vehicle share link.");

  const url = new URL(API_URL);
  url.searchParams.set("type", "v");
  url.searchParams.set("uuid", parsed.uuid);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://tracking.gomotive.com/",
      "X-Web-Share-Api-Key": process.env.MOTIVE_WEB_SHARE_API_KEY || PUBLIC_WEB_SHARE_KEY,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Motive share request failed (${response.status}).`);
  }

  const result = await response.json().catch(() => null);
  const share = result?.live_share;
  const location = share?.vehicle?.vehicle_location;
  const lat = Number(location?.lat);
  const lng = Number(location?.lon);
  if (
    !share ||
    share.uuid !== parsed.uuid ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    throw new Error("Motive share returned no usable vehicle location (the link may have expired).");
  }

  const speed = parseSpeed(location.speed);
  const entityState = String(location.entity_state || "").toLowerCase();
  const motion =
    speed != null
      ? speed > 3 ? "Rolling" : "Stopped"
      : /^(moving|in_motion|rolling)$/.test(entityState)
      ? "Rolling"
      : /^(stopped|idle|parked)$/.test(entityState)
      ? "Stopped"
      : null;

  return {
    truckName: share.vehicle.number || null,
    lat,
    lng,
    formatted:
      location.formatted_address ||
      [location.city, location.state].filter(Boolean).join(", ") ||
      null,
    speed,
    motion,
    fixTimeMs: Date.parse(location.located_at) || null,
    heading: Number.isFinite(Number(location.bearing)) ? Number(location.bearing) : null,
    hasDestination: false,
    destName: null,
    destAddress: null,
    destLat: null,
    destLng: null,
  };
}

function parseSpeed(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = value.match(/([\d.]+)\s*(mph|km\/h|kph)?/i);
  if (!match) return null;
  const speed = Number(match[1]);
  if (!Number.isFinite(speed)) return null;
  return /km\/h|kph/i.test(match[2] || "") ? speed * 0.621371 : speed;
}
