import { registerHooks } from "node:module";
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?js$/.test(specifier)) return nextResolve(`${specifier}.js`, context);
    return nextResolve(specifier, context);
  },
});

let loads = [];
let snapshots = new Map();
let messages = [];
let checked = [];
let delivered = [];
let failId = null;
let failSnapshot = false;
const db = {
  from(table) {
    let field;
    let value;
    const query = {
      select() { return this; },
      eq(key, arg) { field = key; value = arg; return this; },
      is() { return this; },
      order() { return this; },
      async maybeSingle() {
        if (table === "profiles") return { data: value === "11" ? { id: "owner" } : { id: "other" }, error: null };
        if (table === "telegram_update_batches") return { data: snapshots.get(value) || null, error: null };
        throw new Error(`unexpected maybeSingle: ${table}`);
      },
      async upsert(record) {
        if (failSnapshot) return { error: { code: "test", message: "missing table" } };
        snapshots.set(record.user_id, record);
        return { error: null };
      },
      then(resolve, reject) {
        assert.equal(table, "loads");
        assert.equal(field, "user_id");
        return Promise.resolve({ data: loads.filter((load) => load.user_id === value), error: null }).then(resolve, reject);
      },
    };
    return query;
  },
};
function stub(path, namedExports) { mock.module(path, { namedExports }); }
stub("../lib/supabase.js", { getSupabase: () => db });
stub("../lib/telegram.js", {
  telegramWebhookSecret: () => "secret",
  configureTelegramWebhook: async () => ({}),
  sendTelegramMessage: async (chatId, text, options) => { messages.push({ chatId, text, options }); },
});
stub("../lib/telegramDelivery.js", {
  deliverTelegramReport: async (supabase, chatId, id, options) => {
    delivered.push({ chatId, id, userId: options.userId });
    return { sent: true };
  },
});
stub("../lib/groq.js", { parseLoadMessage: async () => ({}) });
stub("../lib/shareLink.js", { looksLikeShareUrl: () => false, shareLinkProblem: () => null });
stub("../lib/dispatchTime.js", { appointmentHasPassed: () => false });
const { POST } = await import("../app/api/telegram/webhook/route.js");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
globalThis.fetch = async (url) => {
  const id = Number(url.searchParams.get("load_ids"));
  checked.push(id);
  if (id === failId) throw new DOMException("timeout", "TimeoutError");
  return Response.json({ results: [{ id, status: "on_time" }] });
};

function request(text, chatId = 11) {
  return {
    url: "https://example.test/api/telegram/webhook",
    headers: new Headers({ "x-telegram-bot-api-secret-token": "secret" }),
    async json() { return { message: { chat: { id: chatId, type: "private" }, text } }; },
  };
}
function reset(count) {
  loads = Array.from({ length: count }, (_, i) => ({
    id: i + 1, position: i, user_id: "owner", load_number: `L${i + 1}`,
    deadline: "2026-11-12T12:00", truck_number: "1", status: "on_time", tracking_enabled: false,
  }));
  snapshots = new Map();
  messages = [];
  checked = [];
  delivered = [];
  failId = null;
  failSnapshot = false;
}

test("large updates create stable private groups; each button only checks its own snapshot", async () => {
  reset(7);
  assert.equal((await POST(request("Update all"))).status, 200);
  assert.deepEqual(snapshots.get("owner").groups, [[1, 2, 3], [4, 5, 6], [7]]);
  assert.equal(checked.length, 0);
  assert.match(messages[0].text, /Group 1: #L1, #L2, #L3/);
  assert.deepEqual(messages[0].options.reply_markup.keyboard.flat().map((button) => button.text),
    ["Update all", "Update group 1", "Update group 2", "Update group 3"]);

  loads[0].status = "arrived";
  loads.push({ ...loads[1], id: 8, position: 0 });
  messages = [];
  await POST(request("Update group 1"));
  assert.deepEqual(checked, [2, 3]);
  assert.deepEqual(delivered.map((item) => item.id), [2, 3]);
  assert.match(messages.at(-1).text, /1 load is no longer eligible/);

  checked = [];
  messages = [];
  await POST(request("Update group 1", 22));
  assert.deepEqual(checked, []);
  assert.match(messages.at(-1).text, /no longer available/);
});

test("small updates run directly and report individual timeouts without skipping later loads", async () => {
  reset(3);
  failId = 2;
  await POST(request("/updateall"));
  assert.deepEqual(checked, [1, 2, 3]);
  assert.deepEqual(delivered.map((item) => item.id), [1, 3]);
  assert.match(messages.at(-1).text, /Not confirmed: #L2/);
  assert.match(messages.at(-1).text, /may still be processing/);
  assert.deepEqual(snapshots.get("owner").groups, []);
});

test("13 Track-off loads can be updated across all five groups", async () => {
  reset(13);
  await POST(request("Update all"));
  for (let group = 1; group <= 5; group++) await POST(request(`Update group ${group}`));
  assert.deepEqual(checked, loads.map((load) => load.id));
  assert.deepEqual(delivered.map((item) => item.id), loads.map((load) => load.id));
  assert.ok(loads.every((load) => load.tracking_enabled === false));
});

test("a new small update invalidates an earlier set of groups", async () => {
  reset(4);
  await POST(request("Update all"));
  loads = loads.slice(0, 2);
  await POST(request("Update all"));
  checked = [];
  messages = [];
  await POST(request("Update group 1"));
  assert.deepEqual(checked, []);
  assert.match(messages.at(-1).text, /no longer available/);
});

test("only eligible loads are updated; Track-off stays unchanged", async () => {
  reset(5);
  loads[1].truck_number = null;
  loads[2].status = "arrived";
  loads[3].deadline = null;
  await POST(request("Update all"));
  assert.deepEqual(checked, [1, 5]);
  assert.ok(loads.every((load) => load.tracking_enabled === false));
});

test("group storage errors are explicit instead of falsely starting an update", async () => {
  reset(4);
  failSnapshot = true;
  const oldError = console.error;
  console.error = () => {};
  try {
    await POST(request("Update all"));
    assert.deepEqual(checked, []);
    assert.match(messages.at(-1).text, /database migration/);
  } finally {
    console.error = oldError;
  }
});
