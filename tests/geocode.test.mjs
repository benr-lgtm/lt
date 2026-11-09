import { registerHooks } from "node:module";
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?js$/.test(specifier)) return nextResolve(`${specifier}.js`, context);
    return nextResolve(specifier, context);
  },
});
mock.module("../lib/usage.js", {
  namedExports: { bumpUsage: async () => {}, underCap: async () => true, nominatimGate: async () => {} },
});
const { geocode } = await import("../lib/maps.js");
const originalFetch = globalThis.fetch;
const originalOrs = process.env.ORS_API_KEY;
const originalGoogle = process.env.GOOGLE_MAPS_KEY;
after(() => {
  globalThis.fetch = originalFetch;
  if (originalOrs === undefined) delete process.env.ORS_API_KEY; else process.env.ORS_API_KEY = originalOrs;
  if (originalGoogle === undefined) delete process.env.GOOGLE_MAPS_KEY; else process.env.GOOGLE_MAPS_KEY = originalGoogle;
});

test("geocoder skips an out-of-ZIP rooftop and chooses the matching fallback", async () => {
  process.env.ORS_API_KEY = "test";
  delete process.env.GOOGLE_MAPS_KEY;
  globalThis.fetch = async (url) => {
    if (url.hostname === "nominatim.openstreetmap.org") return Response.json([{
      lat: "40.94", lon: "-80.83", addresstype: "building",
      address: { house_number: "1", postcode: "44460" },
    }]);
    return Response.json({ features: [{ geometry: { coordinates: [-82.8, 40] },
      properties: { accuracy: "point", postalcode: "43054" } }] });
  };
  const result = await geocode("1 Community Circle, New Albany, OH 43054");
  assert.equal(result.provider, "ors");
  assert.equal(result.lng, -82.8);
});

test("a result lacking the specified ZIP is not treated as an exact address", async () => {
  delete process.env.ORS_API_KEY;
  delete process.env.GOOGLE_MAPS_KEY;
  globalThis.fetch = async () => Response.json([{
    lat: "40.94", lon: "-80.83", addresstype: "building", address: { house_number: "1" },
  }]);
  assert.equal((await geocode("1 Community Circle, New Albany, OH 43054")).precision, "area");
});
