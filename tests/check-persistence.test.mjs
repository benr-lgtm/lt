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
  samsara_url: "motive-share", truck_number: null, destination: "Test",
  dest_lat: 41, dest_lng: -87, deadline: "2026-11-10T12:00",
  tracking_enabled: false, status: "unknown",
};
let writeError = null;
let savedPatch;

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
  getMotiveVehicleGpsByName: async () => new Map(), hasMotiveConfig: () => true,
  parseMotiveTruckNumber: (number) => ({ number, explicit: false }),
});
stub("../lib/shareLink.js", { parseMotiveUrl: () => ({ uuid: "test" }) });
stub("../lib/maps.js", {
  geocode: async () => null, estimateEta: async () => ({ seconds: 3600, milesLeft: 100, provider: "test" }),
  haversineMiles: () => 100, ARRIVAL_MILES: 0.1,
});
stub("../lib/email.js", {
  sendLateEmail: async () => ({}), sendCheckinEmail: async () => ({}),
  sendTrackingLostEmail: async () => ({}), recipientsFor: () => [],
});
stub("../lib/scheduler.js", { nextCheckAt: () => null, slackMsFrom: () => 3600000, graceMs: () => 0 });
stub("../lib/billing.js", { chargeForRow: async () => ({ charged: false }) });
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
