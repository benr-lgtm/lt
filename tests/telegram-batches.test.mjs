import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTelegramLoads, runTelegramBatch, telegramGroupKeyboard } from "../lib/telegramBatches.js";

test("Telegram groups preserve the original loads, including Track-off loads", () => {
  const loads = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, tracking_enabled: false }));
  const groups = groupTelegramLoads(loads);
  assert.deepEqual(groups.map((group) => group.map((load) => load.id)), [[1, 2, 3], [4, 5, 6], [7, 8]]);
  assert.deepEqual(telegramGroupKeyboard(groups.length).keyboard.flat().map((button) => button.text),
    ["Update all", "Update group 1", "Update group 2", "Update group 3"]);
});

test("a group keeps successful checks and reports failures and unfinished loads", async () => {
  let time = 0;
  const checks = [];
  const reports = [];
  const loads = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const results = await runTelegramBatch(loads, {
    deadline: 10000,
    now: () => time,
    async check(id) {
      checks.push(id);
      if (id === 2) throw new Error("provider failed");
      return { id, status: "on_time" };
    },
    async report(id) {
      reports.push(id);
      time = 10000;
      return { sent: true };
    },
  });
  assert.deepEqual(checks, [1]);
  assert.deepEqual(reports, [1]);
  assert.equal(results[0].outcome.status, "on_time");
  assert.equal(results[1].unconfirmed, true);
  assert.equal(results[2].unconfirmed, true);

  time = 0;
  const mixed = await runTelegramBatch(loads, {
    deadline: 10000, now: () => time,
    check: async (id) => {
      if (id === 2) throw new Error("provider failed");
      return { id, status: id === 3 ? "deferred" : "on_time" };
    },
    report: async () => { throw new Error("delivery uncertain"); },
  });
  assert.equal(mixed[0].reportUnconfirmed, true);
  assert.equal(mixed[1].unconfirmed, true);
  assert.equal(mixed[2].unconfirmed, true);
});

test("an invalid checker response is never reported as a completed load", async () => {
  const results = await runTelegramBatch([{ id: 1 }], {
    deadline: 10000, now: () => 0,
    check: async () => ({ id: 1 }),
    report: async () => { throw new Error("should not report"); },
  });
  assert.equal(results[0].unconfirmed, true);
});
