import { test } from "node:test";
import assert from "node:assert/strict";
import { updateRowsOnce } from "../lib/manualUpdates.js";

test("one-time updates process all rows once despite an individual timeout", async () => {
  const rows = Array.from({ length: 13 }, (_, index) => ({ id: index + 1, tracking_enabled: false }));
  const calls = [];
  const progress = [];
  const outcomes = await updateRowsOnce(rows, async (id) => {
    calls.push(id);
    if (id === 5) throw new Error("timeout");
    return { checked: 1 };
  }, (done, total) => progress.push([done, total]));
  assert.deepEqual(calls, rows.map((row) => row.id));
  assert.equal(outcomes[4].error, "timeout");
  assert.equal(outcomes[12].result.checked, 1);
  assert.deepEqual(progress[12], [13, 13]);
});

test("a browser timeout warns that the server might still be processing", async () => {
  const outcomes = await updateRowsOnce([{ id: 1 }, { id: 2 }], async (id) => {
    if (id === 1) throw new DOMException("Aborted", "TimeoutError");
    return { checked: 1 };
  });
  assert.match(outcomes[0].error, /may still be processing/);
  assert.equal(outcomes[1].result.checked, 1);
});
