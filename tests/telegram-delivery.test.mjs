import { registerHooks } from "node:module";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?js$/.test(specifier)) return nextResolve(`${specifier}.js`, context);
    return nextResolve(specifier, context);
  },
});

let row;
let locked = false;
let sent = 0;
let sendHook = async () => {};
let saveError = null;
let releaseError = null;
mock.module("../lib/checkLease.js", { namedExports: {
  acquireCheckLease: async () => {
    if (locked) return null;
    locked = true;
    return { token: "token", load: { ...row } };
  },
  releaseCheckLease: async () => { locked = false; if (releaseError) throw releaseError; },
} });
mock.module("../lib/telegramReport.js", { namedExports: {
  sendTelegramLoadReport: async () => { sent++; await sendHook(); },
} });
const { deliverTelegramReport } = await import("../lib/telegramDelivery.js");
const db = {
  from() {
    let patch;
    return {
      update(value) { patch = value; return this; },
      eq() { return this; },
      select() { return this; },
      async maybeSingle() {
        if (saveError) return { data: null, error: saveError };
        Object.assign(row, patch);
        return { data: { id: row.id }, error: null };
      },
    };
  },
};

test("manual and scheduled delivery serialize and clear the pending event once", async () => {
  row = { id: 1, status: "late", telegram_pending_status: "late" };
  sent = 0;
  let releaseSend;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  sendHook = () => new Promise((resolve) => { releaseSend = resolve; started(); });
  const manual = deliverTelegramReport(db, "chat", 1);
  await startedPromise;
  assert.equal((await deliverTelegramReport(db, "chat", 1, { pendingOnly: true })).busy, true);
  releaseSend();
  assert.equal((await manual).sent, true);
  assert.equal((await deliverTelegramReport(db, "chat", 1, { pendingOnly: true })).sent, false);
  assert.equal(sent, 1);
  assert.equal(row.telegram_pending_status, null);
  assert.ok(row.telegram_late_notified_at);
  sendHook = async () => {};
});

test("an error report preserves a different pending status", async () => {
  row = { id: 1, status: "late", telegram_pending_status: "late" };
  await deliverTelegramReport(db, "chat", 1, { error: "Lookup failed" });
  assert.equal(row.telegram_pending_status, "late");
});

test("failure to save delivery state warns of possible duplicates", async () => {
  row = { id: 1, status: "arrived", telegram_pending_status: "arrived" };
  saveError = { code: "test", message: "failed" };
  const oldError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(deliverTelegramReport(db, "chat", 1), /retrying may duplicate/);
    assert.equal(locked, false);
  } finally {
    console.error = oldError;
    saveError = null;
  }
});

test("delivery refuses a load that no longer belongs to the intended user", async () => {
  row = { id: 1, user_id: "other", status: "late", telegram_pending_status: "late" };
  sent = 0;
  await assert.rejects(deliverTelegramReport(db, "chat", 1, { userId: "owner" }), /ownership changed/);
  assert.equal(sent, 0);
  assert.equal(locked, false);
});

test("a failed delivery does not clear the pending event and warns of uncertainty", async () => {
  row = { id: 1, status: "late", telegram_pending_status: "late" };
  sendHook = async () => { throw new Error("timeout"); };
  const oldWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(deliverTelegramReport(db, "chat", 1), /may have been sent/);
    assert.equal(row.telegram_pending_status, "late");
    assert.equal(locked, false);
  } finally {
    console.warn = oldWarn;
    sendHook = async () => {};
  }
});

test("a lease release failure after delivery reports that the message was sent", async () => {
  row = { id: 1, status: "late", telegram_pending_status: null };
  releaseError = new Error("release failed");
  try {
    await assert.rejects(deliverTelegramReport(db, "chat", 1), /report was sent.*could not be released/);
  } finally {
    releaseError = null;
  }
});
