import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?js$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { writeTrackingResult } = await import("../lib/trackingWrite.js");
const { formatTelegramLoadReport } = await import("../lib/telegramReport.js");

function fakeSupabase(response, calls) {
  const query = {
    update(patch) { calls.push(["update", patch]); return this; },
    eq(field, value) { calls.push(["eq", field, value]); return this; },
    is(field, value) { calls.push(["is", field, value]); return this; },
    select(field) { calls.push(["select", field]); return this; },
    async maybeSingle() { return response; },
  };
  return { from(table) { calls.push(["from", table]); return query; } };
}

test("tracking updates must persist on the active load", async () => {
  const calls = [];
  await writeTrackingResult(fakeSupabase({ data: { id: 12 }, error: null }, calls), 12, { status: "on_time" });
  assert.deepEqual(calls, [
    ["from", "loads"],
    ["update", { status: "on_time" }],
    ["eq", "id", 12],
    ["is", "deleted_at", null],
    ["select", "id"],
  ]);
});

test("database rejection and removed loads cannot report tracking success", async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await assert.rejects(
      writeTrackingResult(fakeSupabase({ data: null, error: { code: "23514", message: "constraint failed" } }, []), 12, {}),
      /database error 23514/
    );
    assert.equal(logged[0][2], "constraint failed");
    await assert.rejects(
      writeTrackingResult(fakeSupabase({ data: null, error: null }, []), 12, {}),
      /load no longer exists/
    );
  } finally {
    console.error = originalError;
  }
});

test("Telegram reports expose tracking errors rather than claiming checking", () => {
  const report = formatTelegramLoadReport({
    position: 0, load_number: "123", kind: "pickup", status: "error",
    status_note: "Could not save tracking result (database error 23514).",
  });
  assert.match(report, /ETA \(PU\): Unavailable \(Tracking issue\)/);
  assert.match(report, /Tracking issue: Could not save tracking result/);
  assert.doesNotMatch(report, /\(Checking\)/);
});
