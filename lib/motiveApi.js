import { normalizeTruck } from "./samsara";
import { getMotiveAccessToken, motiveOAuthConfigured } from "./motiveOAuth";

const MOTIVE_API_BASE = "https://api.gomotive.com/v1/vehicle_locations";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export function parseMotiveTruckNumber(value) {
  const input = String(value || "").trim();
  const match = input.match(/^motive\s*(?::|#)?\s*(.+)$/i);
  return {
    explicit: !!match,
    number: (match ? match[1] : input).trim().replace(/^#/, ""),
  };
}

export function hasMotiveOAuthConfig() {
  return motiveOAuthConfigured();
}

export async function getMotiveVehicleGpsByName() {
  const vehiclesByNumber = new Map();
  let accessToken = await getMotiveAccessToken();
  let pageNo = 1;
  let totalPages = 1;

  while (pageNo <= totalPages && pageNo <= MAX_PAGES) {
    const url = new URL(MOTIVE_API_BASE);
    url.searchParams.set("per_page", String(PAGE_SIZE));
    url.searchParams.set("page_no", String(pageNo));

    const pageResult = await fetchMotivePage(url, accessToken);
    const response = pageResult.response;
    accessToken = pageResult.accessToken;
    if (!response.ok) {
      const message =
        response.status === 401 || response.status === 403
          ? "Motive denied access to vehicle locations. Check the shared OAuth connection and its Locations read permission."
          : `Motive vehicle-location request failed (${response.status}).`;
      throw new Error(message);
    }

    const result = await response.json();
    const vehicles = Array.isArray(result.vehicles)
      ? result.vehicles
      : Array.isArray(result.data?.vehicles)
        ? result.data.vehicles
        : [];
    for (const item of vehicles) {
      const vehicle = item?.vehicle || item;
      const location = vehicle?.current_location || vehicle?.location;
      const lat = parseNumber(location?.lat ?? location?.latitude);
      const lng = parseNumber(location?.lon ?? location?.lng ?? location?.longitude);
      const number = normalizeTruck(vehicle?.number ?? vehicle?.name);
      if (!number) continue;

      const speed = parseNumber(location?.speed);
      const locationType = String(location?.type || "").toLowerCase();
      const motion =
        speed != null
          ? speed > 2
            ? "Rolling"
            : "Stopped"
          : /moving|rolling/.test(locationType)
            ? "Rolling"
            : /stopped|idle|parked/.test(locationType)
              ? "Stopped"
              : null;

      if (!vehiclesByNumber.has(number)) {
        vehiclesByNumber.set(number, {
          lat,
          lng,
          formatted: location?.description || null,
          time: location?.located_at || null,
          speed,
          motion,
          id: vehicle?.id,
          name: vehicle?.number ?? vehicle?.name,
        });
      }
    }

    const pagination = result.pagination || {};
    const total = Number(pagination.total);
    const perPage = Number(pagination.per_page) || PAGE_SIZE;
    totalPages = Number.isFinite(total)
      ? Math.max(1, Math.ceil(total / perPage))
      : Number(pagination.page_no) > 0 && vehicles.length === perPage
        ? pageNo + 1
        : pageNo;
    pageNo++;
  }

  if (pageNo <= totalPages) {
    throw new Error(`Motive fleet exceeds the ${MAX_PAGES * PAGE_SIZE}-vehicle lookup limit.`);
  }
  return vehiclesByNumber;
}

async function fetchMotivePage(url, accessToken) {
  let response = await requestPage(url, accessToken);
  if (response.status === 401) {
    accessToken = await getMotiveAccessToken({ forceRefresh: true });
    response = await requestPage(url, accessToken);
  }
  return { response, accessToken };
}

function requestPage(url, accessToken) {
  return fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
}

function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
