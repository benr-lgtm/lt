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
  const etaStatus =
    status === "late"
      ? "Late"
      : status === "on_time"
      ? "On time"
      : status === "arrived"
      ? "Arrived"
      : status === "error"
      ? "Tracking issue"
      : "Checking";
  const eta = status === "arrived" ? "Arrived" : `${load.eta_display || "Unavailable"} (${etaStatus})`;
  const lines = [
    title,
    `Status: ${motion}`,
    `ETA: ${eta}`,
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
  const lines = report.split("\n").map(escapeHtml);
  if (load.load_number) lines[0] = `<code>${lines[0]}</code>`;
  return sendTelegramMessage(chatId, lines.join("\n").slice(0, 4000), { parse_mode: "HTML" });
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
