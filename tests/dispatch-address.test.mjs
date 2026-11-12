import { registerHooks } from "node:module";
import { test, after } from "node:test";
import assert from "node:assert/strict";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?js$/.test(specifier)) return nextResolve(`${specifier}.js`, context);
    return nextResolve(specifier, context);
  },
});

const { parseLoads } = await import("../lib/parseLoads.js");
const { parseLoadMessage } = await import("../lib/groq.js");
const originalFetch = globalThis.fetch;
const originalKey = process.env.GROQ_API_KEY;
after(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
});

const dispatch = `PU: 11/09/2026 0900
MARGO GARDEN
PRODUCTS - JACKSONVILLE 2
10501 COLD STORAGE ROAD,
BUILDING #100
JACKSONVILLE, FL 32218

DEL: 11/10/2026 1400
FEDEX GROUND PACKAGE SYSTEMS
Building #200
3100 Northwest 35th Avenue Roa
Ocala, FL
34475`;

test("address blocks select the street, not the building, including a ZIP on the next line", () => {
  const [pickup, delivery] = parseLoads(dispatch);
  assert.equal(pickup.destination, "10501 COLD STORAGE ROAD, JACKSONVILLE, FL 32218");
  assert.deepEqual(pickup.addressDetails, ["BUILDING #100"]);
  assert.equal(delivery.destination, "3100 Northwest 35th Avenue Roa, Ocala, FL 34475");
  assert.deepEqual(delivery.addressDetails, ["Building #200"]);
  assert.equal(parseLoads("PU: 11/09/2026 0900\n123 Building Road, Suite 200\nBoston, MA\n02108")[0].destination,
    "123 Building Road, Boston, MA 02108");
});

test("Groq import preserves facility names and stop-specific building details", async () => {
  process.env.GROQ_API_KEY = "test";
  globalThis.fetch = async (url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content;
    assert.match(prompt, /ZIP are split across separate lines/);
    assert.match(prompt, /Building, suite, unit, block, dock/);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ loads: [{ stops: [
      { kind: "pickup", facility: "MARGO GARDEN PRODUCTS - JACKSONVILLE 2", appointmentAt: "2026-11-09T09:00", destination: "10501 COLD STORAGE ROAD, JACKSONVILLE, FL 32218" },
      { kind: "delivery", facility: "FEDEX GROUND PACKAGE SYSTEMS", appointmentAt: "2026-11-10T14:00", destination: "3100 Northwest 35th Avenue Roa, Ocala, FL 34475" },
    ] }] }) } }] });
  };
  const stops = await parseLoadMessage(dispatch);
  assert.equal(stops[0].facility, "MARGO GARDEN PRODUCTS - JACKSONVILLE 2");
  assert.equal(stops[0].destination, "10501 COLD STORAGE ROAD, JACKSONVILLE, FL 32218");
  assert.match(stops[0].notes, /BUILDING #100/);
  assert.equal(stops[1].destination, "3100 Northwest 35th Avenue Roa, Ocala, FL 34475");
  assert.match(stops[1].notes, /Building #200/);
  assert.doesNotMatch(stops[1].notes, /BUILDING #100/);
});

test("an incomplete source guess cannot overwrite a complete model address", async () => {
  process.env.GROQ_API_KEY = "test";
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ loads: [{ stops: [
    { kind: "delivery", facility: "Warehouse", appointmentAt: "2026-11-10T14:00", destination: "42 Main Street, Boston, MA 02108" },
  ] }] }) } }] });
  const stops = await parseLoadMessage("DEL: 11/10/2026 1400\nWarehouse\nStreet address: 42 Main Street\nBuilding #200\nBoston, MA 02108");
  assert.equal(stops[0].destination, "42 Main Street, Boston, MA 02108");
  assert.match(stops[0].notes, /Building #200/);
});

test("preserves a street without inventing a missing house number", async () => {
  process.env.GROQ_API_KEY = "test";
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ loads: [{ stops: [
    { kind: "delivery", facility: "Home Depot", appointmentAt: "2026-11-12T08:00", destination: "737 River Valley Drive, Saint Louis, MO 63146" },
  ] }] }) } }] });
  const input = "DEL: 11/12/2026 0800\nHome Depot\nRiver Valley Drive\nSaint Louis, MO 63146";
  assert.equal(parseLoads(input)[0].destination, "River Valley Drive, Saint Louis, MO 63146");
  assert.equal((await parseLoadMessage(input))[0].destination, "River Valley Drive, Saint Louis, MO 63146");
});

test("extracts address blocks from the supplied dispatch formats", () => {
  const first = parseLoads(`📍 ***PICKUP*****:** 11/11/2026 6:05 AM
FEDEX GROUND PACKAGE SYSTEMS,
12501 NE 40th Street
Kansas City, MO 64161
📍 ***DELIVERY*****:** 11/12/2026 Straight Drop
FEDEX GROUND PACKAGE SYSTEM
13701 SW Anthony F Sansone SR
Port Saint Lucie, FL 34987`);
  assert.equal(first[0].destination, "12501 NE 40th Street, Kansas City, MO 64161");
  assert.equal(first[1].destination, "13701 SW Anthony F Sansone SR, Port Saint Lucie, FL 34987");
  assert.equal(first[1].timeAssumed, true);

  const second = parseLoads(`PU: 11/12/26 0705 AM
FEDEX GROUND PACKAGE SYSTEMS,
135 COLEMAN BLVD.
Pooler, GA 31322
DEL: 11/13/26 1355 or Straight drop
FEDEX GROUND PACKAGE SYSTEMS,
8951 Yosemite Street
Henderson, CO 80640`);
  assert.equal(second[0].destination, "135 COLEMAN BLVD., Pooler, GA 31322");
  assert.equal(second[1].destination, "8951 Yosemite Street, Henderson, CO 80640");

  const third = parseLoads(`DEL: 11/12/2026 0800-1600 PM
Home Depot 3PL MDO #5243
River Valley Drive
Saint Louis, MO 63146`);
  assert.equal(third[0].destination, "River Valley Drive, Saint Louis, MO 63146");
  assert.equal(third[0].deadline, "2026-11-12T16:00");
});
