import { getSupabase } from "../../../lib/supabase";
import {
  getVehicleGpsByName,
  hasSamsaraToken,
  normalizeTruck,
  tzFromCoords,
  localToIso,
  formatEta,
} from "../../../lib/samsara";
import { fetchShareLocation } from "../../../lib/samsaraShare";
import { geocode, estimateEta, haversineMiles, ARRIVAL_MILES } from "../../../lib/maps";
import { sendLateEmail, sendCheckinEmail, recipientsFor } from "../../../lib/email";
import { nextCheckAt, slackMsFrom, graceMs } from "../../../lib/scheduler";
import { chargeForRow } from "../../../lib/billing";
import { decryptSecret } from "../../../lib/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FALLBACK_TZ = process.env.DEFAULT_TIMEZONE || "America/Chicago";
const CHECKIN_LEAD_MS = 5 * 60 * 1000;
const CHECKIN_REPROMPT_MS = 15 * 60 * 1000;

// GET /api/check?key=CHECK_SECRET
//
// Sweeps only rows whose next_check_at has come due. The cron fires every couple
// of minutes but almost always finds little to do — that's what makes frequent
// scheduling affordable.
export async function GET(req) {
  const url = new URL(req.url);
  const secret = process.env.CHECK_SECRET;
  if (secret && url.searchParams.get("key") !== secret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = Math.max(1, parseInt(process.env.CHECK_BATCH || "40", 10));
  const supabase = getSupabase(); // service role: the worker spans all tenants
  const nowIso = new Date().toISOString();

  try {
    const { data: due, error } = await supabase
      .from("loads")
      .select("*")
      .not("next_check_at", "is", null)
      .lte("next_check_at", nowIso)
      .order("next_check_at", { ascending: true })
      .limit(limit);
    if (error) throw error;

    const results = [];
    const byUser = groupBy(due || [], (l) => l.user_id);

    for (const [userId, loads] of byUser) {
      const ctx = await userContext(supabase, userId, loads);
      for (const load of loads) {
        results.push(await checkOne(supabase, load, ctx));
      }
    }

    // Check-in prompts are time-driven, not position-driven, so they're swept
    // separately from the ETA work.
    const checkins = await sweepCheckins(supabase);

    return Response.json({ checked: results.length, checkins, results });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// Per-user setup: their Samsara token, and one GPS fetch shared by all of
// their truck# rows rather than one call per row.
async function userContext(supabase, userId, loads) {
  const ctx = { gpsByName: null, gpsError: null, profile: null };
  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "id,balance_cents,samsara_token_enc,checkin_email_default," +
        "notify_email,notify_alert,notify_remind," +
        "cc1_email,cc1_alert,cc1_remind,cc2_email,cc2_alert,cc2_remind"
    )
    .eq("id", userId)
    .maybeSingle();
  ctx.profile = profile || null;

  if (!loads.some((l) => l.truck_number)) return ctx;

  const userToken = decryptSecret(profile?.samsara_token_enc);
  const extra = userToken ? [userToken] : [];
  if (!hasSamsaraToken(extra)) {
    ctx.gpsError = "No Samsara API token on this account — add one in Settings, or use a Live Share link.";
    return ctx;
  }
  try {
    const errs = [];
    ctx.gpsByName = await getVehicleGpsByName(errs, extra);
    if (errs.length && ctx.gpsByName.size === 0) ctx.gpsError = errs[0];
  } catch (e) {
    ctx.gpsError = e.message;
  }
  return ctx;
}

async function checkOne(supabase, load, ctx) {
  const out = { id: load.id, position: load.position };
  try {
    // ---- 1. where is the truck? ----
    const pos = await resolvePosition(load, ctx);
    if (pos.error) return fail(supabase, load, pos.error, out);

    // ---- 2. where is it going? ----
    const dest = await resolveDestination(supabase, load, pos);
    if (dest.error) return fail(supabase, load, dest.error, out, pos);

    // ---- 3. arrival is pure geometry — costs no API quota ----
    const straightMiles = haversineMiles(
      { lat: pos.lat, lng: pos.lng },
      { lat: dest.lat, lng: dest.lng }
    );
    const tz = tzFromCoords(dest.lat, dest.lng) || FALLBACK_TZ;

    if (pos.precision === "exact" && straightMiles != null && straightMiles < ARRIVAL_MILES) {
      // Arrival is completion, and completion is when the row is billed. This
      // is the only place an ordinary delivery gets charged; a load that never
      // reaches its destination is never charged at all.
      //
      // Wrapped because a billing failure must not take the arrival down with
      // it: the surrounding catch would mark this row "Couldn't track", turning
      // a successfully delivered load into a visible tracking failure over a
      // ledger write. charged_at stays null so it can be collected later.
      let charged = false;
      try {
        const charge = await chargeForRow(supabase, load);
        charged = charge.charged;
      } catch (e) {
        out.chargeError = String(e.message).slice(0, 150);
      }
      return await finish(supabase, load, {
        ...out,
        status: "arrived",
        charged,
        patch: {
          status: "arrived",
          status_note: null,
          arrived_at: load.arrived_at || new Date().toISOString(),
          miles_left: 0,
          // Arrived rows stop costing anything unless a check-in is still pending.
          next_check_at: load.checkin_enabled && load.checkin_state !== "checked_in"
            ? load.next_check_at
            : null,
        },
        pos,
      });
    }

    // ---- 4. ETA ----
    const est = await estimateEta(
      { lat: pos.lat, lng: pos.lng },
      { lat: dest.lat, lng: dest.lng },
      { timeZone: tz }
    );
    const etaIso = new Date(Date.now() + est.seconds * 1000).toISOString();
    const deadlineIso = localToIso(load.deadline, tz);
    const slack = slackMsFrom(etaIso, deadlineIso);
    const late = slack != null && slack < -graceMs();
    const status = slack == null ? "unknown" : late ? "late" : "on_time";

    // ---- 5. nothing is billed here ----
    // A row in transit has not delivered its answer yet. Billing moved to
    // completion (arrival, or check-in) so an abandoned load costs nothing, and
    // there is deliberately no balance gate: tracking is never withheld over
    // money, because a load that silently stopped being watched is the single
    // worst thing this app can do to someone.

    // ---- 6. alert on the flip to late, once ----
    // `alerted` is only ever set once the provider has confirmed the send, so a
    // refused email is retried on the next sweep instead of being lost. Whatever
    // went wrong is written to status_note so it shows in the row's tooltip —
    // silent alert failures are worse than no tracking at all, because the user
    // believes they are covered.
    let alerted = load.alerted;
    let alertNote = null;
    // alert_enabled is the row's own opt-out; older rows predate the column and
    // read as undefined, which must count as enabled rather than silently off.
    const alertOn = load.alert_enabled !== false;
    if (late && alertOn && !load.alerted) {
      const to = recipientsFor(ctx.profile, "alert");
      if (to.length === 0) {
        alertNote = "Late, but no alert recipient is enabled — check Settings.";
      } else {
        try {
          const res = await sendLateEmail({
            to,
            load: {
              ...load,
              eta_display: formatEta(etaIso, tz),
              truck_at: pos.formatted,
              miles_left: est.milesLeft,
            },
          });
          out.emailed = res.sent;
          // Marked alerted as soon as at least one copy landed: retrying to fix
          // one bad address would re-send to everyone who already got it, and
          // duplicate late alerts erode trust in the alert faster than a missing
          // one does. The failures are surfaced on the row instead.
          if (res.sent.length > 0) alerted = true;
          if (res.errors.length > 0) {
            out.emailErrors = res.errors;
            const first = res.errors[0];
            alertNote =
              `Alert not delivered to ${first.to}: ${String(first.error).slice(0, 110)}` +
              (res.errors.length > 1 ? ` (+${res.errors.length - 1} more)` : "");
          }
        } catch (e) {
          out.emailError = e.message;
          alertNote = `Late alert not sent: ${String(e.message).slice(0, 150)}`;
        }
      }
    }
    if (!late && load.status === "late") alerted = false;

    return await finish(supabase, load, {
      ...out,
      status,
      eta: formatEta(etaIso, tz),
      patch: {
        status,
        status_note: alertNote,
        alerted,
        eta_iso: etaIso,
        eta_display: formatEta(etaIso, tz),
        eta_provider: est.provider,
        miles_left: est.milesLeft,
        dest_lat: dest.lat,
        dest_lng: dest.lng,
        checkin_due_at: checkinDueAt(load, tz),
        next_check_at: nextCheckAt({ slackMs: slack }),
      },
      pos,
    });
  } catch (e) {
    return fail(supabase, load, e.message?.slice(0, 200) || "check failed", out);
  }
}

// Truck# via the Samsara API, or a Live Share link via the GraphQL endpoint.
async function resolvePosition(load, ctx) {
  if (load.truck_number) {
    if (ctx.gpsError) return { error: ctx.gpsError };
    const gps = ctx.gpsByName?.get(normalizeTruck(load.truck_number));
    if (!gps) return { error: "Truck not found in the connected Samsara account" };
    return {
      lat: gps.lat,
      lng: gps.lng,
      formatted: gps.formatted,
      source: "samsara_api",
      precision: "exact",
      tier: null,
    };
  }

  if (load.samsara_url) {
    const share = await fetchShareLocation(load.samsara_url);
    return {
      lat: share.lat,
      lng: share.lng,
      formatted: share.formatted,
      source: "graphql",
      precision: "exact",
      tier: 1,
      share,
    };
  }

  return { error: "Add a truck # or a Live Share link" };
}

// Destination priority: the address the user pasted (geocoded once and cached),
// then whatever the share link itself carries.
async function resolveDestination(supabase, load, pos) {
  if (load.dest_lat != null && load.dest_lng != null) {
    return { lat: load.dest_lat, lng: load.dest_lng };
  }
  if (load.destination) {
    try {
      const hit = await geocode(load.destination);
      if (hit) return { lat: hit.lat, lng: hit.lng };
    } catch (e) {
      return { error: `Couldn't locate the destination address (${e.message})` };
    }
    return { error: "Couldn't locate the destination address" };
  }
  if (pos.share?.hasDestination) {
    return { lat: pos.share.destLat, lng: pos.share.destLng };
  }
  return { error: "Destination required — paste the delivery address" };
}

function checkinDueAt(load, tz) {
  if (!load.checkin_enabled) return null;
  const appt = load.appt_at || load.deadline;
  const iso = localToIso(appt, tz);
  if (!iso) return null;
  return new Date(new Date(iso).getTime() - CHECKIN_LEAD_MS).toISOString();
}

async function finish(supabase, load, { patch, pos, ...rest }) {
  await supabase
    .from("loads")
    .update({
      ...patch,
      truck_at: pos?.formatted ?? load.truck_at,
      last_lat: pos?.lat ?? load.last_lat,
      last_lng: pos?.lng ?? load.last_lng,
      last_place: pos?.formatted ?? load.last_place,
      position_source: pos?.source ?? load.position_source,
      position_precision: pos?.precision ?? load.position_precision,
      link_tier: pos?.tier ?? load.link_tier,
      updated_at: new Date().toISOString(),
    })
    .eq("id", load.id);
  return rest;
}

// A failing row must not be retried in a hot loop — back it off to 30 minutes.
async function fail(supabase, load, note, out, pos = null) {
  await supabase
    .from("loads")
    .update({
      status: "error",
      status_note: String(note).slice(0, 200),
      next_check_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      last_lat: pos?.lat ?? load.last_lat,
      last_lng: pos?.lng ?? load.last_lng,
      last_place: pos?.formatted ?? load.last_place,
      updated_at: new Date().toISOString(),
    })
    .eq("id", load.id);
  return { ...out, status: "error", error: note };
}

// Rows whose check-in window has opened: mark them due, and email once if the
// user opted in. Re-prompting for a missed check-in is in-app only — it must
// never turn into a recurring email.
async function sweepCheckins(supabase) {
  const now = new Date().toISOString();
  const { data: rows } = await supabase
    .from("loads")
    .select("*")
    .eq("checkin_enabled", true)
    .not("checkin_due_at", "is", null)
    .lte("checkin_due_at", now)
    .is("checkin_state", null)
    .limit(50);

  let prompted = 0;
  const emailErrors = [];
  for (const load of rows || []) {
    await supabase
      .from("loads")
      .update({ checkin_state: "due", checkin_prompted_at: now })
      .eq("id", load.id);
    prompted++;

    const { data: profile } = await supabase
      .from("profiles")
      .select(
        "notify_email,notify_alert,notify_remind,cc1_email,cc1_alert,cc1_remind,cc2_email,cc2_alert,cc2_remind"
      )
      .eq("id", load.user_id)
      .maybeSingle();
    const to = recipientsFor(profile, "remind");
    if (to.length > 0) {
      try {
        const res = await sendCheckinEmail({ to, load });
        for (const e of res.errors) {
          emailErrors.push({ id: load.id, to: e.to, error: String(e.error).slice(0, 150) });
        }
      } catch (e) {
        // An email failure still must not block the in-app prompt, but it is
        // reported rather than discarded — the previous bare `catch {}` is why
        // a broken mail provider could go unnoticed indefinitely.
        emailErrors.push({ id: load.id, error: String(e.message).slice(0, 150) });
      }
    }
  }

  // Missed check-ins keep nagging in the UI until someone resolves them.
  const { data: missed } = await supabase
    .from("loads")
    .select("id,checkin_prompted_at")
    .eq("checkin_state", "missed")
    .lte("checkin_prompted_at", new Date(Date.now() - CHECKIN_REPROMPT_MS).toISOString())
    .limit(50);
  for (const m of missed || []) {
    await supabase
      .from("loads")
      .update({ checkin_prompted_at: now })
      .eq("id", m.id);
  }

  return {
    prompted,
    reprompted: (missed || []).length,
    ...(emailErrors.length ? { emailErrors } : {}),
  };
}

function groupBy(list, fn) {
  const m = new Map();
  for (const item of list) {
    const k = fn(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
}
