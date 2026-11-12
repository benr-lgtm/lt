import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?js$/.test(specifier)) return nextResolve(`${specifier}.js`, context);
    return nextResolve(specifier, context);
  },
});
const { fetchShareLocation } = await import("../lib/samsaraShare.js");

test("Samsara share authentication and retry use one deadline", async () => {
  const oldFetch = globalThis.fetch;
  const oldTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  AbortSignal.timeout = () => controller.signal;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options.signal, controller.signal);
    if (calls === 1) return Response.json({ csrf_token: "test" });
    if (calls === 2) return new Response(null, { status: 401 });
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    throw controller.signal.reason;
  };
  try {
    await assert.rejects(fetchShareLocation("https://cloud.samsara.com/o/1/fleet/viewer/test"), { name: "TimeoutError" });
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = oldFetch;
    AbortSignal.timeout = oldTimeout;
  }
});
