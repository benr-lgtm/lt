import { registerHooks } from "node:module";
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?js$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});

let oauthConfigured = false;
let refreshes = 0;
mock.module("../lib/motiveOAuth.js", {
  namedExports: {
    motiveOAuthConfigured: () => oauthConfigured,
    getMotiveAccessToken: async ({ forceRefresh = false } = {}) => {
      if (forceRefresh) refreshes++;
      return forceRefresh ? "refreshed-token" : "oauth-token";
    },
  },
});

const { getMotiveVehicleGpsByName, hasMotiveConfig, parseMotiveTruckNumber } =
  await import("../lib/motiveApi.js");
const { fetchMotiveLocation } = await import("../lib/motiveShare.js");
const originalFetch = globalThis.fetch;
const originalKey = process.env.MOTIVE_API_KEY;
const originalApi = process.env.MOTIVE_API;
const originalShareKey = process.env.MOTIVE_WEB_SHARE_API_KEY;

after(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.MOTIVE_API_KEY;
  else process.env.MOTIVE_API_KEY = originalKey;
  if (originalApi === undefined) delete process.env.MOTIVE_API;
  else process.env.MOTIVE_API = originalApi;
  if (originalShareKey === undefined) delete process.env.MOTIVE_WEB_SHARE_API_KEY;
  else process.env.MOTIVE_WEB_SHARE_API_KEY = originalShareKey;
});

test("API key authenticates paginated vehicle lookups, including absent pagination", async () => {
  process.env.MOTIVE_API_KEY = "test-key";
  process.env.MOTIVE_API = "older-key";
  oauthConfigured = false;
  assert.equal(hasMotiveConfig(), true);
  assert.deepEqual(parseMotiveTruckNumber("Motive: #1356"), { explicit: true, number: "1356" });
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options.headers["X-Api-Key"], "test-key");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(url.searchParams.get("page_no"), String(calls));
    if (calls === 1) {
      return Response.json({
        vehicles: Array.from({ length: 100 }, (_, i) => ({
          vehicle: { number: `T${i}`, current_location: { lat: 41, lon: -87 } },
        })),
      });
    }
    return Response.json({
      vehicles: [{ vehicle: { number: "1356", current_location: {
        lat: 42, lon: -88, speed: 45, description: "Test", located_at: "2026-01-01T00:00:00Z",
      } } }],
    });
  };
  const vehicles = await getMotiveVehicleGpsByName();
  assert.equal(calls, 2);
  assert.deepEqual(vehicles.get("1356"), {
    lat: 42, lng: -88, speed: 45, motion: "Rolling", formatted: "Test",
    time: "2026-01-01T00:00:00Z", id: undefined, name: "1356",
  });
});

test("API key verification checks only one page and reports permission failures", async () => {
  process.env.MOTIVE_API_KEY = "test-key";
  refreshes = 0;
  globalThis.fetch = async (url) => {
    assert.equal(url.searchParams.get("per_page"), "1");
    return Response.json({ vehicles: [], pagination: { total: 999 } });
  };
  await getMotiveVehicleGpsByName({ verifyOnly: true });
  globalThis.fetch = async () => new Response(null, { status: 401 });
  await assert.rejects(getMotiveVehicleGpsByName(), /MOTIVE_API.*Locations read permission/);
  assert.equal(refreshes, 0);
  globalThis.fetch = async () => Response.json({ unexpected: true });
  await assert.rejects(getMotiveVehicleGpsByName(), /invalid vehicle-location response/);
});

test("Motive fleet pagination uses one shared deadline and rejects incomplete results", async () => {
  process.env.MOTIVE_API_KEY = "test-key";
  const controller = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => controller.signal;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options.signal, controller.signal);
    if (calls === 1) return Response.json({
      vehicles: [{ vehicle: { number: "1", current_location: { lat: 41, lon: -87 } } }],
      pagination: { total: 2, per_page: 1 },
    });
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    throw controller.signal.reason;
  };
  try {
    await assert.rejects(getMotiveVehicleGpsByName(), { name: "TimeoutError" });
    assert.equal(calls, 2);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("existing MOTIVE_API variable authenticates without OAuth", async () => {
  delete process.env.MOTIVE_API_KEY;
  process.env.MOTIVE_API = "existing-key";
  oauthConfigured = false;
  assert.equal(hasMotiveConfig(), true);
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers["X-Api-Key"], "existing-key");
    return Response.json({ vehicles: [], pagination: { total: 0 } });
  };
  assert.equal((await getMotiveVehicleGpsByName()).size, 0);
});

test("OAuth remains available and retries a 401 with a refreshed token", async () => {
  delete process.env.MOTIVE_API_KEY;
  delete process.env.MOTIVE_API;
  oauthConfigured = true;
  refreshes = 0;
  assert.equal(hasMotiveConfig(), true);
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, `Bearer ${calls === 1 ? "oauth-token" : "refreshed-token"}`);
    assert.equal(options.headers["X-Api-Key"], undefined);
    return calls === 1
      ? new Response(null, { status: 401 })
      : Response.json({ vehicles: [], pagination: { total: 0 } });
  };
  assert.equal((await getMotiveVehicleGpsByName()).size, 0);
  assert.equal(refreshes, 1);
});

test("Motive share requires real coordinates and preserves valid locations", async () => {
  delete process.env.MOTIVE_WEB_SHARE_API_KEY;
  const uuid = "11111111-2222-3333-4444-555555555555";
  const url = `https://tracking.gomotive.com/share/v/${uuid}`;
  globalThis.fetch = async () => Response.json({
    live_share: { uuid, vehicle: { number: "1356", vehicle_location: { lat: null, lon: null } } },
  });
  await assert.rejects(fetchMotiveLocation(url), /no usable vehicle location/);
  globalThis.fetch = async () => Response.json({
    live_share: { uuid, vehicle: { number: "1356", vehicle_location: {
      lat: "41.2", lon: "-87.3", speed: "50 mph", city: "Chicago", state: "IL",
    } } },
  });
  const position = await fetchMotiveLocation(url);
  assert.equal(position.lat, 41.2);
  assert.equal(position.lng, -87.3);
  assert.equal(position.motion, "Rolling");
  assert.equal(position.formatted, "Chicago, IL");
});

test("Motive share key fallback uses one deadline", async () => {
  process.env.MOTIVE_WEB_SHARE_API_KEY = "test-key";
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  AbortSignal.timeout = () => controller.signal;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options.signal, controller.signal);
    if (calls === 1) return new Response(null, { status: 401 });
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    throw controller.signal.reason;
  };
  try {
    await assert.rejects(fetchMotiveLocation("https://tracking.gomotive.com/share/v/11111111-2222-3333-4444-555555555555"), { name: "TimeoutError" });
    assert.equal(calls, 2);
  } finally {
    AbortSignal.timeout = originalTimeout;
    delete process.env.MOTIVE_WEB_SHARE_API_KEY;
  }
});
