import { registerHooks } from "node:module";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?js$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});

const load = {
  id: 1, position: 0, user_id: "user", load_number: "123",
  samsara_url: "motive-share", truck_number: null, destination: "1 Test St",
  dest_lat: 41, dest_lng: -87, dest_precision: "point", deadline: "2026-11-10T12:00",
  tracking_enabled: false, status: "unknown",
};
let writeError = null;
let savedPatch;
let motiveVehicles = new Map();
let geocodeHit = null;
let geocodeCalls = 0;
let distance = 100;
let chargeCalls = 0;

const supabase = {
  from(table) {
    const query = {
      select() { return this; },
      is() { return this; },
      not() { return this; },
      in() { return this; },
      limit() { return this; },
      eq() { return this; },
      update(patch) { savedPatch = patch; this.writing = true; return this; },
      async maybeSingle() {
        return this.writing
          ? { data: writeError ? null : { id: 1 }, error: writeError }
          : { data: null, error: null };
      },
      then(resolve, reject) {
        return Promise.resolve({ data: table === "loads" ? [load] : null, error: null }).then(resolve, reject);
      },
    };
    return query;
  },
};

function stub(path, namedExports) {
  mock.module(path, { namedExports });
}
stub("../lib/supabase.js", { getSupabase: () => supabase });
stub("../lib/samsara.js", {
  getVehicleGpsByName: async () => new Map(), hasSamsaraToken: () => false,
  normalizeTruck: (value) => String(value), tzFromCoords: () => "America/Chicago",
  localToIso: () => "2026-11-10T18:00:00Z", formatEta: () => "ETA", findStopNear: async () => null,
});
stub("../lib/samsaraShare.js", { fetchShareLocation: async () => { throw new Error("Wrong provider"); } });
stub("../lib/motiveShare.js", {
  fetchMotiveLocation: async () => ({ lat: 40, lng: -86, formatted: "Test location", speed: 40, fixTimeMs: Date.now() }),
});
stub("../lib/motiveApi.js", {
  getMotiveVehicleGpsByName: async () => motiveVehicles, hasMotiveConfig: () => true,
  parseMotiveTruckNumber: (number) => ({ number, explicit: false }),
});
stub("../lib/shareLink.js", { parseMotiveUrl: () => ({ uuid: "test" }) });
stub("../lib/maps.js", {
  geocode: async () => { geocodeCalls++; return geocodeHit; }, estimateEta: async () => ({ seconds: 3600, milesLeft: 100, provider: "test" }),
  haversineMiles: () => distance, ARRIVAL_MILES: 0.1,
});
stub("../lib/email.js", {
  sendLateEmail: async () => ({}), sendCheckinEmail: async () => ({}),
  sendTrackingLostEmail: async () => ({}), recipientsFor: () => [],
});
stub("../lib/scheduler.js", { nextCheckAt: () => null, slackMsFrom: () => 3600000, graceMs: () => 0 });
stub("../lib/billing.js", { chargeForRow: async () => { chargeCalls++; return { charged: false }; } });
stub("../lib/crypto.js", { decryptSecret: () => null });
stub("../lib/telegramReport.js", { sendTelegramLoadReport: async () => {} });

const { GET } = await import("../app/api/check/route.js");

test("manual Motive check returns success only after saving the GPS result", async () => {
  writeError = null;
  const url = new URL("https://example.test/api/check?load_ids=1");
  if (process.env.CHECK_SECRET) url.searchParams.set("key", process.env.CHECK_SECRET);
  const result = await (await GET({ url: url.href })).json();
  assert.equal(result.results[0].status, "on_time");
  assert.equal(savedPatch.position_source, "motive_share");
  assert.equal(savedPatch.truck_at, "Test location");
  assert.equal(savedPatch.eta_display, "ETA");
});

test("manual Motive check reports a database error instead of false success", async () => {
  writeError = { code: "23514", message: "constraint failed" };
  const oldError = console.error;
  console.error = () => {};
  try {
    const url = new URL("https://example.test/api/check?load_ids=1");
    if (process.env.CHECK_SECRET) url.searchParams.set("key", process.env.CHECK_SECRET);
    const result = await (await GET({ url: url.href })).json();
    assert.equal(result.results[0].status, "error");
    assert.equal(result.results[0].persisted, false);
    assert.match(result.results[0].error, /database error 23514/);
  } finally {
    console.error = oldError;
  }
});

test("cached approximate destination is retried and cannot produce misleading miles", async () => {
  writeError = null;
  load.dest_precision = "area";
  load.miles_left = 167;
  geocodeCalls = 0;
  geocodeHit = { lat: 41, lng: -87, precision: "area" };
  const url = new URL("https://example.test/api/check?load_ids=1");
  if (process.env.CHECK_SECRET) url.searchParams.set("key", process.env.CHECK_SECRET);
  const result = await (await GET({ url: url.href })).json();
  assert.equal(geocodeCalls, 1);
  assert.match(result.results[0].error, /approximate/);
  assert.equal(savedPatch.miles_left, null);
  assert.equal(savedPatch.eta_display, null);
  load.dest_precision = "point";
  delete load.miles_left;
});

test("validated area estimate is cached, warned, and never auto-arrives", async () => {
  writeError = null;
  load.dest_lat = null;
  load.dest_lng = null;
  load.dest_precision = null;
  geocodeCalls = 0;
  geocodeHit = { lat: 40, lng: -86, precision: "area", estimateAllowed: true };
  distance = 0;
  chargeCalls = 0;
  const url = new URL("https://example.test/api/check?load_ids=1");
  if (process.env.CHECK_SECRET) url.searchParams.set("key", process.env.CHECK_SECRET);
  const result = await (await GET({ url: url.href })).json();
  assert.notEqual(result.results[0].status, "arrived");
  assert.equal(chargeCalls, 0);
  assert.equal(savedPatch.dest_precision, "area_estimate");
  assert.match(savedPatch.status_note, /Approximate destination/);
  assert.equal(savedPatch.miles_left, 100);
  load.dest_lat = savedPatch.dest_lat;
  load.dest_lng = savedPatch.dest_lng;
  load.dest_precision = savedPatch.dest_precision;
  await GET({ url: url.href });
  assert.equal(geocodeCalls, 1);
  load.dest_lat = 41;
  load.dest_lng = -87;
  load.dest_precision = "point";
  distance = 100;
});

test("legacy point cache for an unnumbered address is rechecked", async () => {
  load.destination = "River Valley Drive, Saint Louis, MO 63146";
  load.dest_precision = "point";
  geocodeCalls = 0;
  geocodeHit = { lat: 40, lng: -86, precision: "area", estimateAllowed: true };
  distance = 0;
  chargeCalls = 0;
  const url = new URL("https://example.test/api/check?load_ids=1");
  if (process.env.CHECK_SECRET) url.searchParams.set("key", process.env.CHECK_SECRET);
  const result = await (await GET({ url: url.href })).json();
  assert.equal(geocodeCalls, 1);
  assert.notEqual(result.results[0].status, "arrived");
  assert.equal(savedPatch.dest_precision, "area_estimate");
  assert.equal(chargeCalls, 0);
  load.destination = "1 Test St";
  distance = 100;
});

test("ambiguous numeric Motive truck lookup returns selectable candidates", async () => {
  load.samsara_url = null;
  load.truck_number = "707";
  motiveVehicles = new Map([
    ["707 oo", { name: "707 OO", lat: 40, lng: -86 }],
    ["707tt", { name: "707TT", lat: 40, lng: -86 }],
  ]);
  const url = new URL("https://example.test/api/check?load_ids=1");
  if (process.env.CHECK_SECRET) url.searchParams.set("key", process.env.CHECK_SECRET);
  const result = await (await GET({ url: url.href })).json();
  assert.equal(result.results[0].status, "error");
  assert.deepEqual(result.results[0].candidates.map((candidate) => candidate.source), ["Motive: 707 OO", "Motive: 707TT"]);
  load.samsara_url = "motive-share";
  load.truck_number = null;
  motiveVehicles = new Map();
});
