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

const { parseLoads } = await import("../lib/parseLoads.js");

test("sloppy times like '12: 00' and windows parse", () => {
  const [a, b] = parseLoads("Delivery: 11/10/26 08:00 - 12: 00\nX\n1 Main St\nDallas, TX 75001\n————\nDelivery: 11/10/26 12: 00 PM\nY\n2 Main St\nDallas, TX 75001");
  assert.equal(a.appointmentAt, "2026-11-10T08:00");
  assert.equal(a.deadline, "2026-11-10T12:00");
  assert.equal(b.appointmentAt, "2026-11-10T12:00");
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
      properties: { accuracy: "point", postalcode: "43054", housenumber: "1", street: "Community Circle" } }] });
  };
  const result = await geocode("1 Community Circle, New Albany, OH 43054");
  assert.equal(result.provider, "ors");
  assert.equal(result.lng, -82.8);
});

test("a result lacking a postcode is still accepted as an exact address", async () => {
  delete process.env.ORS_API_KEY;
  delete process.env.GOOGLE_MAPS_KEY;
  globalThis.fetch = async () => Response.json([{
    lat: "40.94", lon: "-80.83", addresstype: "building", address: { house_number: "1", road: "Community Circle" },
  }]);
  assert.equal((await geocode("1 Community Circle, New Albany, OH 43054")).precision, "point");
});

test("a lone result with a different ZIP is rejected", async () => {
  delete process.env.ORS_API_KEY;
  delete process.env.GOOGLE_MAPS_KEY;
  globalThis.fetch = async () => Response.json([{
    lat: "40.94", lon: "-80.83", addresstype: "building", address: { house_number: "1", postcode: "44460" },
  }]);
  const r = await geocode("1 Community Circle, New Albany, OH 43054");
  assert.equal(r, null);
});

test("US suffix retains ZIP validation and retries a simplified address", async () => {
  delete process.env.ORS_API_KEY;
  delete process.env.GOOGLE_MAPS_KEY;
  const queries = [];
  globalThis.fetch = async (url) => {
    queries.push(url.searchParams.get("q"));
    if (queries.length === 1) return Response.json([{
      lat: "27.3", lon: "-80.4", addresstype: "building",
      address: { house_number: "13701", postcode: "34986" },
    }]);
    return Response.json([{
      lat: "27.2", lon: "-80.4", addresstype: "building",
      address: { house_number: "13701", road: "SW Anthony F. Sansone Sr. Boulevard", postcode: "34987", "ISO3166-2-lvl4": "US-FL" },
    }]);
  };
  const result = await geocode("13701 SW Anthony F. Sansone Sr. Blvd, Port St. Lucie, FL 34987, United States");
  assert.equal(result.precision, "point");
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[1], /34987|United States/);
});

test("selects a matching numbered address instead of an unrelated first result", async () => {
  delete process.env.ORS_API_KEY;
  delete process.env.GOOGLE_MAPS_KEY;
  globalThis.fetch = async () => Response.json([
    { lat: "39", lon: "-105", addresstype: "building", address: { house_number: "8951", postcode: "80201" } },
    { lat: "39.9", lon: "-104.9", addresstype: "building", address: {
      house_number: "8951", road: "Yosemite St", postcode: "80640", "ISO3166-2-lvl4": "US-CO",
    } },
  ]);
  const result = await geocode("8951 Yosemite Street Henderson, CO 80640");
  assert.equal(result.precision, "point");
  assert.equal(result.lat, 39.9);
});

test("missing house number yields an estimate, never an exact facility", async () => {
  delete process.env.ORS_API_KEY;
  delete process.env.GOOGLE_MAPS_KEY;
  globalThis.fetch = async () => Response.json([{
    lat: "38.7", lon: "-90.4", addresstype: "postcode",
    address: { postcode: "63146", "ISO3166-2-lvl4": "US-MO" },
  }]);
  const result = await geocode("River Valley Drive Saint Louis, MO 63146", "Home Depot");
  assert.equal(result.precision, "area");
  assert.equal(result.estimateAllowed, true);
});

test("rejects state conflict and uncorroborated area fallback", async () => {
  delete process.env.ORS_API_KEY;
  delete process.env.GOOGLE_MAPS_KEY;
  globalThis.fetch = async () => Response.json([{
    lat: "38.7", lon: "-90.4", addresstype: "postcode",
    address: { postcode: "63146", "ISO3166-2-lvl4": "US-IL" },
  }]);
  assert.equal(await geocode("River Valley Drive Saint Louis, MO 63146"), null);
  globalThis.fetch = async () => Response.json([{ lat: "38.7", lon: "-90.4", addresstype: "city", address: {} }]);
  assert.equal(await geocode("River Valley Drive Saint Louis, MO 63146"), null);
});

test("continues to a configured provider after another provider fails", async () => {
  process.env.ORS_API_KEY = "test";
  delete process.env.GOOGLE_MAPS_KEY;
  globalThis.fetch = async (url) => {
    if (url.hostname === "nominatim.openstreetmap.org") return new Response("", { status: 503 });
    return Response.json({ features: [{ geometry: { coordinates: [-104.9, 39.9] },
      properties: { accuracy: "point", housenumber: "8951", postalcode: "80640", street: "Yosemite Street" } }] });
  };
  assert.equal((await geocode("8951 Yosemite Street Henderson, CO 80640")).provider, "ors");
});

test("a point with an unconfirmed house number is not trusted as an exact destination", async () => {
  delete process.env.ORS_API_KEY;
  delete process.env.GOOGLE_MAPS_KEY;
  globalThis.fetch = async () => Response.json([{
    lat: "39.9", lon: "-104.9", addresstype: "building",
    address: { road: "Yosemite Street", postcode: "80640" },
  }]);
  assert.equal((await geocode("8951 Yosemite Street Henderson, CO 80640")).precision, "street");
});
