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

test("failed full addresses can use a matching ZIP as an area estimate", async () => {
  delete process.env.ORS_API_KEY;
  delete process.env.GOOGLE_MAPS_KEY;
  globalThis.fetch = async (url) => {
    const query = url.searchParams.get("q");
    if (/^\d{5}$/.test(query)) return Response.json([{
      lat: "41", lon: "-93", addresstype: "postcode", address: { postcode: query },
    }]);
    return Response.json([]);
  };
  for (const address of [
    "500 N Austin Blvd, Red Oak, TX 75154",
    "14701 Blaine Ave, Rosemount, MN 55068",
    "14100 Park Vista, Fort Worth, TX 76177",
    "3012 Preston Highway, Sheperdsville, KY 40165",
    "542 SW Commerce CT, Prineville, OR 97754",
  ]) {
    const result = await geocode(address);
    assert.equal(result.precision, "area", address);
    assert.equal(result.estimateAllowed, true, address);
  }
});

test("the reported numbered destinations accept matching provider street variants", async () => {
  delete process.env.ORS_API_KEY;
  delete process.env.GOOGLE_MAPS_KEY;
  const cases = [
    ["500 N Austin Blvd, Red Oak, TX 75154", "500", "North Austin Boulevard", "75154", "point"],
    ["14701 Blaine Ave, Rosemount, MN 55068", "14701", "Blaine Avenue", "55068", "point"],
    ["14100 Park Vista, Fort Worth, TX 76177", "14100", "Park Vista Boulevard", "76177", "street"],
    ["3012 Preston Highway, Sheperdsville, KY 40165", "3012", "Preston Hwy", "40165", "point"],
    ["542 SW Commerce CT, Prineville, OR 97754", "542", "Southwest Commerce Court", "97754", "point"],
  ];
  for (const [address, house, road, postcode, precision] of cases) {
    globalThis.fetch = async (url) => Response.json(/^\d{5}$/.test(url.searchParams.get("q")) ? [] : [{
      lat: "39", lon: "-96", addresstype: "building",
      address: { house_number: house, road, postcode },
    }]);
    const result = await geocode(address);
    assert.equal(result?.precision, precision, address);
  }
});

test("a missing street suffix can match only as an estimate with matching house and ZIP", async () => {
  delete process.env.ORS_API_KEY;
  delete process.env.GOOGLE_MAPS_KEY;
  globalThis.fetch = async () => Response.json([{
    lat: "32.9", lon: "-97.3", addresstype: "building",
    address: { house_number: "14100", road: "Park Vista Boulevard", postcode: "76177" },
  }]);
  const result = await geocode("14100 Park Vista, Fort Worth, TX 76177");
  assert.equal(result.precision, "street");
});

test("a missing-suffix match rejects different house, ZIP, or street", async () => {
  delete process.env.ORS_API_KEY;
  delete process.env.GOOGLE_MAPS_KEY;
  for (const address of [
    "14101 Park Vista, Fort Worth, TX 76177",
    "14100 Park Vista, Fort Worth, TX 76178",
    "14100 Park Vista Drive, Fort Worth, TX 76177",
    "14100 Park Vista North, Fort Worth, TX 76177",
  ]) {
    globalThis.fetch = async (url) => Response.json(/^\d{5}$/.test(url.searchParams.get("q")) ? [] : [{
      lat: "32.9", lon: "-97.3", addresstype: "building",
      address: { house_number: "14100", road: "Park Vista Boulevard", postcode: "76177" },
    }]);
    assert.equal(await geocode(address), null, address);
  }
});

test("an unavailable provider is not reported as a definite no-match", async () => {
  process.env.ORS_API_KEY = "test";
  delete process.env.GOOGLE_MAPS_KEY;
  globalThis.fetch = async (url) => url.hostname === "nominatim.openstreetmap.org"
    ? new Response("", { status: 503 })
    : Response.json({ features: [] });
  await assert.rejects(geocode("14100 Park Vista, Fort Worth, TX 76177"), /incomplete.*provider was unavailable/);
});

test("Google API quota errors are not mistaken for no results", async () => {
  delete process.env.ORS_API_KEY;
  process.env.GOOGLE_MAPS_KEY = "test";
  globalThis.fetch = async (url) => url.hostname === "nominatim.openstreetmap.org"
    ? Response.json([])
    : Response.json({ status: "OVER_QUERY_LIMIT", results: [] });
  await assert.rejects(geocode("14100 Park Vista, Fort Worth, TX 76177"), /incomplete.*rate-limited/);
});

test("provider diagnostics do not expose addresses or underlying error details", async () => {
  delete process.env.ORS_API_KEY;
  delete process.env.GOOGLE_MAPS_KEY;
  const originalWarn = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(args);
  globalThis.fetch = async () => { throw new Error("sensitive provider detail"); };
  try {
    await assert.rejects(geocode("1 Private Street, Dallas, TX 75001"), /provider was unavailable/);
    assert.ok(logs.length);
    assert.doesNotMatch(JSON.stringify(logs), /Private Street|sensitive provider detail/);
  } finally {
    console.warn = originalWarn;
  }
});

test("a provider timeout is distinguished from a destination no-match", async () => {
  delete process.env.ORS_API_KEY;
  delete process.env.GOOGLE_MAPS_KEY;
  const originalWarn = console.warn;
  console.warn = () => {};
  globalThis.fetch = async () => { throw new DOMException("timeout", "TimeoutError"); };
  try {
    await assert.rejects(geocode("1 Main St, Dallas, TX 75001"), /lookup timed out/);
  } finally {
    console.warn = originalWarn;
  }
});
