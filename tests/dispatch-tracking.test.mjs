import { registerHooks } from "node:module";
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?js$/.test(specifier)) return nextResolve(`${specifier}.js`, context);
    return nextResolve(specifier, context);
  },
});
let telegramPayload;
mock.module("../lib/telegram.js", {
  namedExports: { sendTelegramMessage: async (...args) => { telegramPayload = args; } },
});
const { parseLoads } = await import("../lib/parseLoads.js");
const { parseLoadMessage } = await import("../lib/groq.js");
const { findTruckMatches } = await import("../lib/truckLookup.js");
const { sendTelegramLoadReport } = await import("../lib/telegramReport.js");
const originalFetch = globalThis.fetch;
const originalGroq = process.env.GROQ_API_KEY;
after(() => {
  globalThis.fetch = originalFetch;
  if (originalGroq === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalGroq;
});

test("yearless dispatch dates use the current year without inventing a time", async () => {
  const year = new Date().getFullYear();
  const input = "DEL: 11/10 12:00\n1 Main St\nColumbus, OH 43054";
  assert.equal(parseLoads(input)[0].deadline, `${year}-11-10T12:00`);
  assert.equal(parseLoads("PU: 11/10-1200\n1 Main St\nColumbus, OH 43054")[0].deadline, `${year}-11-10T12:00`);
  assert.equal(parseLoads("PU: 11/10\n1 Main St\nColumbus, OH 43054")[0].timeAssumed, true);
  const window = parseLoads("PU: 11/10/27 08:00-16:00\n1 Main St\nColumbus, OH 43054")[0];
  assert.equal(window.appointmentAt, "2027-11-10T08:00");
  assert.equal(window.deadline, "2027-11-10T16:00");
  process.env.GROQ_API_KEY = "test";
  globalThis.fetch = async (url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content;
    assert.match(prompt, new RegExp(`If a date omits its year, use ${year}`));
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      loads: [{ stops: [{ kind: "delivery", appointmentAt: null, destination: "1 Main St, Columbus, OH 43054" }] }],
    }) } }] });
  };
  const stops = await parseLoadMessage(input);
  assert.equal(stops[0].appointmentAt, `${year}-11-10T12:00`);
});

test("numeric truck numbers match letter suffixes only when unambiguous", () => {
  const fleets = [{ provider: "samsara", vehicles: new Map([
    ["707 оо", { name: "707 ОО" }], ["555tt", { name: "555TT" }],
    ["7071", { name: "7071" }],
  ]) }];
  assert.equal(findTruckMatches("707", fleets)[0].gps.name, "707 ОО");
  assert.equal(findTruckMatches("555", fleets)[0].gps.name, "555TT");
  fleets[0].vehicles.set("707ab", { name: "707AB" });
  assert.equal(findTruckMatches("707", fleets).length, 2);
  fleets[0].vehicles.set("707", { name: "707" });
  assert.deepEqual(findTruckMatches("707", fleets).map((match) => match.gps.name), ["707"]);
  assert.deepEqual(findTruckMatches("70", fleets), []);
});

test("Telegram report is fully copyable, contains no ETA, and escapes HTML", async () => {
  await sendTelegramLoadReport(12, {
    load_number: "A<&", status: "on_time", motion: "Rolling",
    motion_updated_at: new Date().toISOString(), eta_display: "10:00", miles_left: 13,
  });
  const [, message, extra] = telegramPayload;
  assert.match(message, /^<pre>[\s\S]*<\/pre>$/);
  assert.match(message, /A&lt;&amp;/);
  assert.match(message, /13 miles left/);
  assert.doesNotMatch(message, /ETA|10:00/);
  assert.equal(extra.parse_mode, "HTML");
});
