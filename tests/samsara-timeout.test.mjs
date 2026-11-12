import { test } from "node:test";
import assert from "node:assert/strict";
import { getVehicleGpsByName } from "../lib/samsara.js";

test("fleet lookup has a shared deadline and reports an incomplete search", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const token = process.env.SAMSARA_API_TOKEN;
  const tokens = process.env.SAMSARA_API_TOKENS;
  delete process.env.SAMSARA_API_TOKEN;
  delete process.env.SAMSARA_API_TOKENS;
  let calls = 0;
  const controller = new AbortController();
  AbortSignal.timeout = () => controller.signal;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options.signal, controller.signal);
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    throw controller.signal.reason;
  };
  try {
    const errors = [];
    const results = await getVehicleGpsByName(errors, ["first", "second"]);
    assert.equal(results.size, 0);
    assert.equal(calls, 1);
    assert.match(errors[0], /timed out/);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    if (token === undefined) delete process.env.SAMSARA_API_TOKEN; else process.env.SAMSARA_API_TOKEN = token;
    if (tokens === undefined) delete process.env.SAMSARA_API_TOKENS; else process.env.SAMSARA_API_TOKENS = tokens;
  }
});
