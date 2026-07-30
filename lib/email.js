import { Resend } from "resend";

// NOTE ON DELIVERABILITY: Resend's shared `onboarding@resend.dev` sender only
// delivers to the address the Resend account was registered with. With multiple
// users that means everyone except the owner silently receives nothing — so a
// verified domain in RESEND_FROM is required before inviting anyone.

function appUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")
  ).replace(/\/$/, "");
}

function client() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("Missing RESEND_API_KEY env var.");
  return new Resend(apiKey);
}

function from() {
  return process.env.RESEND_FROM || "Load Tracker <onboarding@resend.dev>";
}

// Resend's SDK resolves with { data, error } instead of rejecting when the API
// refuses a send. Awaiting it therefore looks like success even when nothing was
// sent, which is exactly how loads ended up flagged `alerted` with no email
// anywhere: a 403 for an unverified sending domain was swallowed here, the
// caller's catch never ran, and the flag suppressed every later retry.
// Every send goes through this wrapper so a refusal is always an exception.
async function send(payload) {
  const res = await client().emails.send(payload);
  const error = res?.error;
  if (error) {
    const detail =
      error.message || error.name || JSON.stringify(error).slice(0, 200);
    throw new Error(`Resend refused the send: ${detail}`);
  }
  if (!res?.data?.id) {
    throw new Error("Resend returned no message id — treating as not sent.");
  }
  return res.data;
}

// One message per recipient, never a shared To: or BCC. These addresses belong
// to different companies — a broker's customer must not learn the carrier's or
// the driver's address by reading the headers of an alert.
//
// Returns { sent: [...addresses], errors: [{ to, error }] }. Partial success is
// normal (one bad address shouldn't hide the others) so this resolves rather
// than throwing, and the caller decides what a partial result means.
async function sendEach(recipients, payload) {
  const list = [...new Set((recipients || []).map((r) => String(r || "").trim()).filter(Boolean))];
  const out = { sent: [], errors: [] };
  for (const to of list) {
    try {
      await send({ ...payload, to });
      out.sent.push(to);
    } catch (e) {
      out.errors.push({ to, error: e.message });
    }
  }
  return out;
}

function kindWords(load) {
  const pickup = load.kind === "pickup";
  return { abbr: pickup ? "PU" : "DEL", word: pickup ? "pickup" : "delivery" };
}

function miles(v) {
  return typeof v === "number" && Number.isFinite(v) ? `${Math.round(v)} mi` : "—";
}

function shell({ heading, sub, rows, load, cta }) {
  const link = appUrl() ? `${appUrl()}/?load=${load.id || ""}` : null;
  const button = link
    ? `<p style="margin:22px 0 0">
         <a href="${link}" style="background:#1c64f2;color:#fff;text-decoration:none;
            padding:10px 18px;border-radius:6px;font-weight:600;display:inline-block">
           ${escapeHtml(cta)}
         </a>
       </p>`
    : "";
  return `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#111">
      <h2 style="margin:0 0 4px">${escapeHtml(heading)}</h2>
      <p style="margin:0 0 14px;color:#666">${escapeHtml(sub)}</p>
      <table style="border-collapse:collapse">
        ${rows
          .map(
            ([k, v]) =>
              `<tr><td style="padding:4px 14px 4px 0;color:#666;vertical-align:top">${escapeHtml(
                k
              )}</td><td><b>${escapeHtml(v)}</b></td></tr>`
          )
          .join("")}
      </table>
      ${button}
      <p style="color:#9aa0aa;margin-top:18px;font-size:13px">
        Automated alert from STL Truckers Load Tracker.
      </p>
    </div>`;
}

// Sent once, on the flip from on-time to late. `to` may be a single address or
// a list; each recipient gets their own copy.
export async function sendLateEmail({ to, load }) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.some((r) => String(r || "").trim())) {
    throw new Error("No notification email set.");
  }
  const { abbr, word } = kindWords(load);
  const facility = load.name || "—";

  // Facility name sits directly under the deadline, and the old redundant
  // "Load" row is gone.
  const rows = [
    ["Truck #", load.truck_number || (load.samsara_url ? "Live Share link" : "—")],
    [`${abbr} by`, load.deadline || "—"],
    ["Facility name", facility],
    ["Destination", load.destination || "—"],
    ["Projected ETA", load.eta_display || "—"],
    ["Truck now near", load.truck_at || "—"],
    ["Miles left", miles(load.miles_left)],
    ["Notes", load.notes || "—"],
  ];

  const subject = `⚠️ Late: ${facility !== "—" ? facility : "Load"}${
    load.destination ? ` → ${load.destination}` : ""
  }`;

  return sendEach(recipients, {
    from: from(),
    subject,
    html: shell({
      heading: "Load is running late",
      sub: `The projected ETA is past the ${word} deadline.`,
      rows,
      load,
      cta: "Open in Load Tracker",
    }),
    text:
      `Load is running late — projected ETA is past the ${word} deadline.\n\n` +
      rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
      (appUrl() ? `\n\nOpen: ${appUrl()}/?load=${load.id || ""}` : "") +
      "\n",
  });
}

// Sent once when the check-in window opens. Deliberately one-shot: the
// "didn't check in" nag lives in the UI so it can't burn the daily send quota.
export async function sendCheckinEmail({ to, load }) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.some((r) => String(r || "").trim())) {
    throw new Error("No notification email set.");
  }
  const { abbr } = kindWords(load);
  const facility = load.name || "—";

  const rows = [
    ["Truck #", load.truck_number || (load.samsara_url ? "Live Share link" : "—")],
    [`${abbr} by`, load.appt_at || load.deadline || "—"],
    ["Facility name", facility],
    ["Destination", load.destination || "—"],
    ["Truck now near", load.truck_at || load.last_place || "—"],
    ["Notes", load.notes || "—"],
  ];

  return sendEach(recipients, {
    from: from(),
    subject: `⏰ Check-in due: ${facility !== "—" ? facility : "Load"}`,
    html: shell({
      heading: "Driver check-in due in 5 minutes",
      sub: "Confirm the driver has walked in and checked in with the facility office.",
      rows,
      load,
      cta: "Mark checked in",
    }),
    text:
      "Driver check-in due in 5 minutes.\n\n" +
      rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
      (appUrl() ? `\n\nOpen: ${appUrl()}/?load=${load.id || ""}` : "") +
      "\n",
  });
}

/**
 * Who should receive a given kind of email for this account.
 *
 * `kind` is "alert" (ETA went late) or "remind" (check-in due). The primary
 * notify_email plus the two optional addresses each carry their own flags, so
 * the customer can be told a load is late without being copied on internal
 * driver check-in reminders.
 *
 * Kept here rather than in the cron route so the UI, the cron and any future
 * caller can never disagree about who is on the list.
 */
export function recipientsFor(profile, kind) {
  if (!profile) return [];
  const flag = kind === "remind" ? "remind" : "alert";
  const out = [];
  const add = (email, on) => {
    const e = String(email || "").trim();
    if (e && on) out.push(e);
  };
  add(profile.notify_email, profile[`notify_${flag}`] !== false);
  add(profile.cc1_email, profile[`cc1_${flag}`]);
  add(profile.cc2_email, profile[`cc2_${flag}`]);
  return [...new Set(out)];
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
