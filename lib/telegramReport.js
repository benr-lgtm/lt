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
  const eta = status === "arrived" ? "Arrived" : load.eta_display || "Unavailable";
  return [
    title,
    `Status: ${motion}`,
    `ETA: ${eta} (${etaStatus})`,
    load.truck_at ? `Current location: ${load.truck_at}` : null,
    typeof load.miles_left === "number" ? `${Math.round(load.miles_left)} miles left` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function sendTelegramLoadReport(chatId, load, status = load.status) {
  const report = formatTelegramLoadReport(load, status);
  let escaped = "";
  for (const character of report) {
    const encoded = character
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    if (escaped.length + encoded.length > 3980) break;
    escaped += encoded;
  }
  return sendTelegramMessage(chatId, `<pre>${escaped}</pre>`, { parse_mode: "HTML" });
}
