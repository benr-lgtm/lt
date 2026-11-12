import { registerHooks } from "node:module";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?js$/.test(specifier)) return nextResolve(`${specifier}.js`, context);
    return nextResolve(specifier, context);
  },
});

const original = {
  id: 1, position: 0, name: "Warehouse", destination: "Old Road, Saint Louis, MO 63146",
  kind: "delivery", truck_number: "123", samsara_url: null, deadline: "2026-11-12T12:00",
  dest_lat: 38, dest_lng: -90, dest_precision: "area_estimate", dest_span_miles: 3,
};
let patch;
const supabase = {
  from(table) {
    return {
      select() { return this; },
      update(value) { patch = value; return this; },
      eq() { return this; },
      is() { return this; },
      order() { return this; },
      maybeSingle: async () => ({ data: {}, error: null }),
      then(resolve, reject) {
        return Promise.resolve({ data: table === "loads" ? [original] : null, error: null }).then(resolve, reject);
      },
    };
  },
};
mock.module("../lib/supabaseServer.js", { namedExports: {
  getSessionUser: async () => ({ supabase, user: { id: "user" }, profile: {} }),
  unauthorized: () => new Response(null, { status: 401 }),
} });
mock.module("../lib/shareLink.js", { namedExports: { looksLikeShareUrl: () => false, shareLinkProblem: () => null } });
mock.module("../lib/samsara.js", { namedExports: { tzFromCoords: () => null } });
mock.module("../lib/rows.js", { namedExports: { MAX_ROWS: 20 } });
const { PUT } = await import("../app/api/loads/route.js");

async function save(overrides) {
  patch = null;
  const row = { ...original, source: "123", ...overrides };
  const response = await PUT({ json: async () => ({ rows: [row] }) });
  assert.equal(response.status, 200);
  return patch;
}

test("editing a destination clears all cached destination metadata", async () => {
  const updated = await save({ destination: "New Road, Saint Louis, MO 63146" });
  for (const key of ["dest_lat", "dest_lng", "dest_precision", "dest_span_miles"]) {
    assert.equal(updated[key], null, key);
  }
});

test("editing the facility invalidates an area estimate but unchanged saves preserve it", async () => {
  const changed = await save({ name: "New warehouse" });
  assert.equal(changed.dest_lat, null);
  assert.equal(changed.dest_precision, null);
  const unchanged = await save({});
  assert.equal(unchanged.dest_lat, 38);
  assert.equal(unchanged.dest_precision, "area_estimate");
});
