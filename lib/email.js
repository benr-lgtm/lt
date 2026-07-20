import { Resend } from "resend";

// Send a "load is running late" alert via Resend.
export async function sendLateEmail({ to, load }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || "Load Tracker <onboarding@resend.dev>";
  if (!apiKey) throw new Error("Missing RESEND_API_KEY env var.");
  if (!to) throw new Error("No notification email set.");

  const resend = new Resend(apiKey);
  const label = load.name ? load.name : `Truck ${load.truck_number || ""}`.trim();
  const kind = load.kind === "pickup" ? "PU" : "DEL";
  const kindWord = load.kind === "pickup" ? "pickup" : "delivery";
  const dest = load.destination ? ` → ${load.destination}` : "";

  const subject = `⚠️ Late: ${label}${dest}`;
  const rows = [
    ["Load", label],
    ["Truck #", load.truck_number || "—"],
    [`${kind} by`, load.deadline || "—"],
    ["Destination", load.destination || "—"],
    ["Projected ETA", load.eta_display || "—"],
    ["Truck now near", load.truck_at || "—"],
  ];

  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#111">
      <h2 style="margin:0 0 4px">Load is running late</h2>
      <p style="margin:0 0 14px;color:#666">
        The projected ETA is past the ${escapeHtml(kindWord)} deadline.
      </p>
      <table style="border-collapse:collapse">
        ${rows
          .map(
            ([k, v]) =>
              `<tr><td style="padding:4px 14px 4px 0;color:#666">${escapeHtml(
                k
              )}</td><td><b>${escapeHtml(v)}</b></td></tr>`
          )
          .join("")}
      </table>
      <p style="color:#9aa0aa;margin-top:18px;font-size:13px">
        Automated alert from STL Truckers Load Tracker.
      </p>
    </div>`;

  const text =
    `Load is running late — projected ETA is past the ${kindWord} deadline.\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
    "\n\nAutomated alert from STL Truckers Load Tracker.\n";

  return resend.emails.send({ from, to, subject, html, text });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
