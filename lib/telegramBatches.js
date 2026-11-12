export const TELEGRAM_GROUP_SIZE = 3;
const COMPLETED_STATUSES = new Set(["on_time", "late", "unknown", "arrived", "error"]);

export function groupTelegramLoads(loads) {
  const groups = [];
  for (let i = 0; i < loads.length; i += TELEGRAM_GROUP_SIZE) {
    groups.push(loads.slice(i, i + TELEGRAM_GROUP_SIZE));
  }
  return groups;
}

export function telegramGroupKeyboard(count) {
  const buttons = Array.from({ length: count }, (_, index) => ({ text: `Update group ${index + 1}` }));
  const keyboard = [[{ text: "Update all" }]];
  for (let i = 0; i < buttons.length; i += 3) keyboard.push(buttons.slice(i, i + 3));
  return { keyboard, resize_keyboard: true, is_persistent: true, input_field_placeholder: "Choose a group or paste a load" };
}

export async function runTelegramBatch(loads, { check, report, deadline, now = Date.now }) {
  const results = [];
  for (const load of loads) {
    const remaining = deadline - now();
    if (remaining <= 1000) {
      results.push({ load, unconfirmed: true });
      continue;
    }
    let outcome;
    try {
      outcome = await check(load.id, remaining);
    } catch (error) {
      results.push({ load, unconfirmed: true, error: error.message || "Update failed" });
      continue;
    }
    if (!outcome || !COMPLETED_STATUSES.has(outcome.status)) {
      results.push({ load, unconfirmed: true });
      continue;
    }
    if (now() >= deadline) {
      results.push({ load, outcome, reportUnconfirmed: true });
      continue;
    }
    try {
      const delivery = await report(load.id, outcome);
      results.push({ load, outcome, reportUnconfirmed: !delivery.sent });
    } catch (error) {
      results.push({ load, outcome, reportUnconfirmed: true, error: error.message || "Report failed" });
    }
  }
  return results;
}
