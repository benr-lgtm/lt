import { sendTelegramMessage } from "./telegram";

export function formatTelegramLoadReport(load, status = load.status) {
  const title = load.load_number
    ? `Load #${load.load_number}`
    : load.name || `Load ${Number(load.position) + 1}`;
  const motionAge = Date.now() - Date.parse(load.motion_updated_at || "");
  const motionStale = !Number.isFinite(motionAge) || motionAge > 30 * 60 * 1000;
  const motion = load.motion
    ? `${load.motion === "Rolling" ? "Rolling" : "Not rolling"}${motionStale ? " (stale)" : ""}`
    : "Unavailable";
  const lines = [
    title,
    `Status: ${motion}`,
    status === "arrived"
      ? `Arrival detected${load.arrived_at && Number.isFinite(Date.parse(load.arrived_at)) ? `: ${new Date(load.arrived_at).toISOString().replace("T", " ").slice(0, 16)} UTC` : ""}`
      : null,
    status === "error" && load.status_note ? `Tracking issue: ${load.status_note}` : null,
    load.truck_at ? `Current location: ${load.truck_at}` : null,
  ].filter(Boolean);
  if (typeof load.miles_left === "number") {
    if (load.truck_at) lines.push("");
    lines.push(`${Math.round(load.miles_left)} miles left`);
  }
  return lines.join("\n");
}

export function sendTelegramLoadReport(chatId, load, status = load.status) {
  const report = formatTelegramLoadReport(load, status);
  let safe = "";
  for (const character of report) {
    const escaped = escapeHtml(character);
    if (safe.length + escaped.length > 3989) break;
    safe += escaped;
  }
  return sendTelegramMessage(chatId, `<pre>${safe}</pre>`, { parse_mode: "HTML" });
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
