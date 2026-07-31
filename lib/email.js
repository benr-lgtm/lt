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

/**
 * "1401 W FARMERS AVE, AMARILLO, TX 79118" -> "Amarillo, TX"
 *
 * The subject line has to survive a phone's notification preview, where perhaps
 * forty characters are visible. City and state is the most decision-useful thing
 * that fits: a dispatcher recognises the stop from it instantly, where a street
 * address just eats the space. Falls back to the raw tail rather than dropping
 * the location entirely, since a slightly odd subject beats a vague one.
 */
export function cityState(destination) {
  const raw = String(destination || "").trim();
  if (!raw) return null;
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  // Walk from the end for the "ST 12345" / "ST" chunk; the city is just before.
  const last = parts[parts.length - 1];
  const m = last.match(/^([A-Za-z]{2})\.?(?:\s+\d{5}(?:-\d{4})?)?$/);
  if (m) {
    const city = parts[parts.length - 2];
    return city ? `${titleCase(city)}, ${m[1].toUpperCase()}` : null;
  }
  // Some pastes put the zip on its own: "... , AMARILLO , TX , 79118"
  const st = parts.find((p, i) => i > 0 && /^[A-Za-z]{2}\.?$/.test(p));
  if (st) {
    const city = parts[parts.indexOf(st) - 1];
    return city ? `${titleCase(city)}, ${st.replace(".", "").toUpperCase()}` : null;
  }
  return titleCase(parts[parts.length - 1]);
}

// Load blocks arrive SHOUTING. Lowercasing wholesale would mangle "ST. PAUL"
// and "MCKINNEY", so only the first letter of each word is forced.
function titleCase(s) {
  return String(s)
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\bMc([a-z])/g, (_, c) => "Mc" + c.toUpperCase());
}

// "Truck # 3014", or the best available identifier when there isn't one.
function truckLabel(load) {
  if (load.truck_number) return `Truck # ${load.truck_number}`;
  if (load.samsara_url) return "Shared truck";
  return "Load";
}

// One visual language for both emails: a coloured headline bar, a clean
// two-column fact table, one button. Rows whose value is empty are dropped
// rather than rendered as "—", so the table only ever shows real information.
function shell({ accent, heading, sub, rows, load, cta }) {
  const link = appUrl() ? `${appUrl()}/?load=${load.id || ""}` : null;
  const button = link
    ? `<tr><td style="padding:24px 28px 4px">
         <a href="${link}" style="background:${accent};color:#fff;text-decoration:none;
            padding:11px 20px;border-radius:6px;font-weight:600;display:inline-block;
            font-size:14px">${escapeHtml(cta)}</a>
       </td></tr>`
    : "";
  const body = rows
    .filter(([, v]) => v != null && String(v).trim() && String(v).trim() !== "—")
    .map(
      ([k, v]) => `
        <tr>
          <td style="padding:7px 18px 7px 0;color:#6b7280;font-size:13px;
                     vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td>
          <td style="padding:7px 0;color:#111827;font-size:14px;font-weight:600">
            ${escapeHtml(v)}</td>
        </tr>`
    )
    .join("");

  return `
  <div style="background:#f3f4f6;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"
           style="max-width:520px;margin:0 auto;background:#fff;border-radius:10px;
                  overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
      <tr>
        <td style="background:${accent};padding:18px 28px">
          <div style="color:#fff;font-size:17px;font-weight:700;line-height:1.3">
            ${escapeHtml(heading)}</div>
          <div style="color:rgba(255,255,255,.88);font-size:13px;margin-top:3px">
            ${escapeHtml(sub)}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 28px 4px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"
                 style="width:100%;border-collapse:collapse">${body}</table>
        </td>
      </tr>
      ${button}
      <tr>
        <td style="padding:22px 28px 20px;color:#9ca3af;font-size:12px;
                   border-top:1px solid #f0f1f3">
          Automated alert from
          <a href="${appUrl() || "https://truckon.site"}"
             style="color:#9ca3af">TruckOn.site</a>
        </td>
      </tr>
    </table>
  </div>`;
}

// Plain-text alternative. Some dispatchers read on devices that never render
// the HTML part, so this has to carry the same facts, not a teaser.
function plain({ heading, rows }) {
  return (
    `${heading}\n\n` +
    rows
      .filter(([, v]) => v != null && String(v).trim() && String(v).trim() !== "—")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n") +
    "\n"
  );
}

// Sent once, on the flip from on-time to late. `to` may be a single address or
// a list; each recipient gets their own copy.
export async function sendLateEmail({ to, load }) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.some((r) => String(r || "").trim())) {
    throw new Error("No notification email set.");
  }
  const { abbr, word } = kindWords(load);
  const where = cityState(load.destination);

  const rows = [
    [`${abbr} by`, load.deadline],
    ["Projected ETA", load.eta_display],
    ["Facility", load.name],
    ["Destination", load.destination],
    ["Truck now near", load.truck_at],
    ["Miles left", miles(load.miles_left)],
    ["Notes", load.notes],
  ];

  // "⚠️ Late: Truck # 3014 is late for DEL in Cincinnati, OH"
  // Everything that matters is in the first line, because on a phone that is
  // often the only line anyone reads.
  const subject =
    `⚠️ Late: ${truckLabel(load)} is late for ${abbr}` + (where ? ` in ${where}` : "");

  const heading = `${truckLabel(load)} is running late`;

  return sendEach(recipients, {
    from: from(),
    subject,
    html: shell({
      accent: "#dc2626",
      heading,
      sub: `Projected ETA is past the ${word} deadline${where ? ` in ${where}` : ""}.`,
      rows,
      load,
      cta: "Open in TruckOn",
    }),
    text:
      plain({ heading: `${heading} — projected ETA is past the ${word} deadline.`, rows }) +
      (appUrl() ? `\nOpen: ${appUrl()}/?load=${load.id || ""}\n` : ""),
  });
}

// Sent once when the check-in window opens. Deliberately one-shot: the
// "didn't check in" nag lives in the UI so it can't burn the daily send quota.
export async function sendCheckinEmail({ to, load }) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.some((r) => String(r || "").trim())) {
    throw new Error("No notification email set.");
  }
  const { abbr, word } = kindWords(load);
  const where = cityState(load.destination);

  const rows = [
    [`${abbr} appt`, load.appt_at || load.deadline],
    ["Facility", load.name],
    ["Destination", load.destination],
    ["Truck now near", load.truck_at || load.last_place],
    ["Notes", load.notes],
  ];

  // Same shape as the late alert so the two are recognisable at a glance:
  // "⏰ Check-in: Truck # 3014 due for DEL in Cincinnati, OH"
  const subject =
    `⏰ Check-in: ${truckLabel(load)} due for ${abbr}` + (where ? ` in ${where}` : "");

  const heading = `${truckLabel(load)} check-in due in 5 minutes`;

  return sendEach(recipients, {
    from: from(),
    subject,
    html: shell({
      accent: "#0e7490",
      heading,
      sub: `Confirm the driver has checked in at the ${word} office.`,
      rows,
      load,
      cta: "Mark checked in",
    }),
    text:
      plain({ heading, rows }) +
      (appUrl() ? `\nOpen: ${appUrl()}/?load=${load.id || ""}\n` : ""),
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
