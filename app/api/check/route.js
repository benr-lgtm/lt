import { getSupabase } from "../../../lib/supabase";
import {
  getVehicleGpsByName,
  hasSamsaraToken,
  normalizeTruck,
  tzFromCoords,
  localToIso,
  formatEta,
  findStopNear,
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

// ---- Arrival by dwell ----------------------------------------------------
//
// ARRIVAL_MILES (0.1) marks arrival outright — that close, nothing else needs
// checking. But a tractor in a big DC yard or staged on the street can sit
// several hundred yards from the geocoded pin and never get that close, so a
// second rule catches those: within ARRIVAL_NEAR_MILES *and* stationary for
// ARRIVAL_DWELL_MIN.
//
// The dwell requirement is what makes the wider radius safe. Half a mile alone
// would fire on a truck driving past on the road outside; half a mile plus
// fifteen minutes of not moving is a truck that has stopped there on purpose.
// A red light or a fuel stop does not last fifteen minutes.
const ARRIVAL_NEAR_MILES = Number(process.env.ARRIVAL_NEAR_MILES || 0.5);
const ARRIVAL_DWELL_MS = Number(process.env.ARRIVAL_DWELL_MIN || 15) * 60 * 1000;
// GPS jitter keeps a parked truck reading a fraction of a mph rather than zero.
const STOPPED_MPH = Number(process.env.STOPPED_MPH || 2);

// ---- Runaway guard -------------------------------------------------------
//
// Slack goes negative the moment a load is late, which puts it in the 5-minute
// critical tier — 288 checks a day, forever, for a row nobody will ever close.
// Seven abandoned rows would eat the entire ORS free quota. So tracking stops
// once a load is this far past its alert deadline without arriving. The row
// stays visible and says why; it simply stops costing anything.
const TRACK_MAX_PAST_DEADLINE_MS =
  Number(process.env.TRACK_MAX_HOURS_PAST_DEADLINE || 48) * 60 * 60 * 1000;

// History backfill: at most one call per row per hour, looking back 12 hours.
const HISTORY_MIN_GAP_MS = Number(process.env.HISTORY_MIN_GAP_MIN || 60) * 60 * 1000;
const HISTORY_LOOKBACK_MS = Number(process.env.HISTORY_LOOKBACK_HOURS || 12) * 60 * 60 * 1000;

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
  const ctx = { gpsByName: null, gpsError: null, profile: null, tokens: [] };
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
  // Kept so the history backfill can reach the same account without decrypting
  // the token a second time per row.
  ctx.tokens = extra;
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

    // Track how long the truck has been sitting still near this stop. Any
    // movement, or leaving the radius, resets the clock — so `stopped_since`
    // can only ever describe an unbroken dwell at this destination.
    const nearby =
      pos.precision === "exact" && straightMiles != null && straightMiles < ARRIVAL_NEAR_MILES;
    const stationary = nearby && typeof pos.speed === "number" && pos.speed <= STOPPED_MPH;
    const stoppedSince = stationary ? load.stopped_since || new Date().toISOString() : null;
    const dwelledMs = stoppedSince ? Date.now() - new Date(stoppedSince).getTime() : 0;

    // A destination that resolved to a road or a town is not a place — every
    // distance measured from it is meaningless, so arrival must not be inferred
    // from one. This is the "15100 Thornton Rd" case: the pin landed on the
    // midpoint of a 3.8-mile road, and a truck 296 FEET from the real gas
    // station read as 2.8 miles out. Marking that "arrived" (or not) on
    // distance is guesswork, and it now moves money. The row says so instead,
    // and check-in remains the way to close it.
    const destTrusted = (dest.precision || "point") === "point";

    const arrivedClose =
      destTrusted && pos.precision === "exact" && straightMiles != null && straightMiles < ARRIVAL_MILES;
    // Speed is only present for truck#/Samsara-API rows. Live Share rows have
    // no speed, so they keep the distance-only rule rather than never arriving.
    const arrivedDwell = destTrusted && stationary && dwelledMs >= ARRIVAL_DWELL_MS;

    // Live checks are samples, so a short stop can fall between two of them.
    // When the appointment has passed and the row still isn't closed, replay
    // the truck's breadcrumbs once and ask whether it was ever parked there.
    let backfill = null;
    if (!arrivedClose && !arrivedDwell && destTrusted) {
      backfill = await historyBackfill(load, dest, ctx);
    }

    if (arrivedClose || arrivedDwell || backfill) {
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
          // Say which rule fired: "arrived" a quarter-mile from the pin looks
          // like a bug unless the row explains that the truck has been parked
          // there for twenty minutes.
          status_note: arrivedClose
            ? null
            : backfill
            ? `Confirmed from Samsara history — parked ${backfill.miles.toFixed(
                2
              )} mi from the address for ${Math.round(backfill.minutes)} min.`
            : `Parked ${straightMiles.toFixed(2)} mi from the address for ${Math.round(
                dwelledMs / 60000
              )} min.`,
          // Backdate to when the truck actually got there, not when we noticed.
          arrived_at:
            load.arrived_at || backfill?.arrivedAt || new Date().toISOString(),
          history_checked_at: backfill ? new Date().toISOString() : load.history_checked_at,
          stopped_since: stoppedSince,
          miles_left: arrivedClose ? 0 : backfill ? backfill.miles : straightMiles,
          // An arrived row is done being tracked — full stop.
          //
          // This previously kept `load.next_check_at` alive while a check-in was
          // pending, which was a bug with two faces: the value retained was the
          // one that made the row due in the FIRST place, i.e. already in the
          // past. So the row stayed permanently due, was re-swept every two
          // minutes forever, and the UI showed it as perpetually "checking"
          // despite reading Arrived.
          //
          // Nothing was gained by it either: sweepCheckins() selects on
          // checkin_due_at and never looks at next_check_at, so check-in
          // prompts fire on their own schedule regardless.
          next_check_at: null,
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

    // ---- 4b. runaway guard ----
    // A row this far past its deadline without arriving is not going to resolve
    // on its own, and left alone it would be re-checked every five minutes
    // indefinitely. Stop scheduling it. The alert has already been sent, the row
    // stays on screen with an explanation, and check-in still closes it.
    const pastDeadlineMs = deadlineIso ? Date.now() - new Date(deadlineIso).getTime() : 0;
    const abandoned = pastDeadlineMs > TRACK_MAX_PAST_DEADLINE_MS;
    if (abandoned) {
      return await finish(supabase, load, {
        ...out,
        status,
        eta: formatEta(etaIso, tz),
        patch: {
          status,
          status_note:
            `Stopped tracking — over ${Math.round(
              TRACK_MAX_PAST_DEADLINE_MS / 3600000
            )}h past the alert time with no arrival. Clear the row, or tick check-in to close it.`,
          eta_iso: etaIso,
          eta_display: formatEta(etaIso, tz),
          eta_provider: est.provider,
          miles_left: est.milesLeft,
          dest_lat: dest.lat,
          dest_lng: dest.lng,
          dest_precision: dest.precision || "point",
          dest_span_miles: dest.spanMiles ?? null,
          stopped_since: stoppedSince,
          next_check_at: null,
        },
        pos,
      });
    }

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
    // A vague destination is the single most misleading state this app can be
    // in — miles and ETA still render, they are just measured from the wrong
    // place — so it gets said plainly on the row rather than buried.
    let alertNote = destTrusted
      ? null
      : dest.precision === "street"
      ? `Approximate destination — matched the street${
          dest.spanMiles ? ` (${dest.spanMiles.toFixed(1)} mi long)` : ""
        }, not the address. Miles and ETA may be off; arrival won't auto-detect. Add a business name or check the address.`
      : "Approximate destination — matched only the city/area. Miles and ETA may be off; arrival won't auto-detect.";
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
              // Lets the email render the appointment as a readable local time
              // instead of the raw "2026-07-31T03:15" it is stored as.
              timeZone: tz,
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
        dest_precision: dest.precision || "point",
        dest_span_miles: dest.spanMiles ?? null,
        // Carried on every check so the dwell clock survives to the next one.
        stopped_since: stoppedSince,
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
      // Drives the dwell-based arrival rule. Only truck#/API rows have it.
      speed: gps.speed,
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
    return {
      lat: load.dest_lat,
      lng: load.dest_lng,
      precision: load.dest_precision || "point",
      spanMiles: load.dest_span_miles,
    };
  }
  if (load.destination) {
    try {
      const hit = await geocode(load.destination);
      if (hit) {
        return {
          lat: hit.lat,
          lng: hit.lng,
          precision: hit.precision || "point",
          spanMiles: hit.spanMiles ?? null,
        };
      }
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

/**
 * Ask Samsara whether this truck was parked at the destination at any point we
 * weren't looking. Returns { arrivedAt, minutes, miles } or null.
 *
 * The gate is the whole design. Unlike the GPS snapshot — one call shared by
 * every row on an account — history is ONE CALL PER VEHICLE, so running it on
 * every check would multiply Samsara traffic by the number of tracked loads.
 * Every condition below exists to keep it rare:
 *
 *   - truck# rows only          (share links have no history and no vehicle id)
 *   - only after the appointment (before that there is nothing to have missed)
 *   - at most once per hour/row  (history_checked_at)
 *   - only while the row is unresolved and worth confirming
 *
 * In practice that is a handful of calls a day, not one per check.
 */
async function historyBackfill(load, dest, ctx) {
  if (!load.truck_number || load.arrived_at) return null;

  const gps = ctx.gpsByName?.get(normalizeTruck(load.truck_number));
  if (!gps?.id) return null;

  // Nothing can have been missed until the appointment has come round.
  const tz = tzFromCoords(dest.lat, dest.lng) || FALLBACK_TZ;
  const apptIso = localToIso(load.appt_at || load.deadline, tz);
  if (!apptIso || Date.now() < new Date(apptIso).getTime()) return null;

  // Rate-limit per row.
  const last = load.history_checked_at ? new Date(load.history_checked_at).getTime() : 0;
  if (Date.now() - last < HISTORY_MIN_GAP_MS) return null;

  // Look back far enough to cover the gap since the last check, but not so far
  // that an earlier visit to the same yard could be mistaken for this trip.
  const since = Date.now() - HISTORY_LOOKBACK_MS;

  try {
    return await findStopNear(gps.id, dest, {
      sinceMs: since,
      nearMiles: ARRIVAL_NEAR_MILES,
      dwellMinutes: ARRIVAL_DWELL_MS / 60000,
      extraTokens: ctx.tokens || [],
    });
  } catch {
    // Never let a history lookup fail the check — it is an enhancement, not a
    // dependency. The row keeps its live-sampled result.
    return null;
  }
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
      // Any successful check ends the failure streak. Without this the counter
      // would accumulate across unrelated outages and eventually make a healthy
      // row give up over failures it had already recovered from.
      fail_count: 0,
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

// Failures that will never fix themselves on a retry. Re-checking these is
// pure waste — the row needs a person, not another attempt.
const PERMANENT_FAILURES = [
  /not a recognizable samsara live share link/i,
  /add a truck # or a live share link/i,
  /destination required/i,
  /share link returned no data/i, // expired or revoked link
];

// Give up after this many consecutive failures even for retryable errors. Five
// tries spans about eight hours with the backoff below — long enough to ride
// out a provider outage, short enough that a genuinely dead row stops costing
// anything the same day.
const MAX_FAILS = Number(process.env.MAX_CONSECUTIVE_FAILS || 5);

/**
 * Record a failed check and decide whether it is worth trying again.
 *
 * The old version rescheduled every failure 30 minutes out, unconditionally and
 * forever — so a mistyped link retried 48 times a day for the life of the row,
 * and the UI never said it had stopped hoping. Now the delay grows with each
 * consecutive failure (30m, 1h, 2h, 4h…), permanent errors stop immediately,
 * and anything still failing after MAX_FAILS stops and says so.
 */
async function fail(supabase, load, note, out, pos = null) {
  const text = String(note);
  const permanent = PERMANENT_FAILURES.some((re) => re.test(text));
  const fails = (load.fail_count || 0) + 1;
  const exhausted = fails >= MAX_FAILS;
  const giveUp = permanent || exhausted;

  // 30m, 1h, 2h, 4h, 8h — capped so it never schedules absurdly far out.
  const backoffMs = Math.min(30 * 60 * 1000 * 2 ** (fails - 1), 8 * 60 * 60 * 1000);

  const suffix = permanent
    ? " Fix the row and press Save & Check."
    : exhausted
    ? ` Stopped after ${fails} failed attempts — fix the row and press Save & Check.`
    : "";

  await supabase
    .from("loads")
    .update({
      status: "error",
      status_note: (text.slice(0, 200 - suffix.length) + suffix).slice(0, 200),
      fail_count: fails,
      next_check_at: giveUp ? null : new Date(Date.now() + backoffMs).toISOString(),
      last_lat: pos?.lat ?? load.last_lat,
      last_lng: pos?.lng ?? load.last_lng,
      last_place: pos?.formatted ?? load.last_place,
      updated_at: new Date().toISOString(),
    })
    .eq("id", load.id);
  return { ...out, status: "error", error: note, gaveUp: giveUp };
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
        const res = await sendCheckinEmail({
          to,
          // Same reason as the late alert: without a zone the appointment
          // prints as a raw ISO-ish string.
          load: { ...load, timeZone: tzFromCoords(load.dest_lat, load.dest_lng) || FALLBACK_TZ },
        });
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
