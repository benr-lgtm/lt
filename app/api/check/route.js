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
import { fetchMotiveLocation } from "../../../lib/motiveShare";
import {
  getMotiveVehicleGpsByName,
  hasMotiveConfig,
  parseMotiveTruckNumber,
} from "../../../lib/motiveApi";
import { parseMotiveUrl } from "../../../lib/shareLink";
import { geocode, estimateEta, haversineMiles, ARRIVAL_MILES } from "../../../lib/maps";
import {
  sendLateEmail,
  sendCheckinEmail,
  sendTrackingLostEmail,
  recipientsFor,
} from "../../../lib/email";
import { nextCheckAt, slackMsFrom, graceMs } from "../../../lib/scheduler";
import { chargeForRow } from "../../../lib/billing";
import { decryptSecret } from "../../../lib/crypto";
import { sendTelegramLoadReport } from "../../../lib/telegramReport";
import { writeTrackingResult } from "../../../lib/trackingWrite";

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
// How far past its closest approach a truck must be before we call it departed.
// Wide enough that GPS jitter and a circuit of a large yard never qualify.
const DEPARTED_MARGIN_MILES = Number(process.env.DEPARTED_MARGIN_MILES || 3);

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

  const requestedIds = url.searchParams.has("load_ids")
    ? url.searchParams
        .get("load_ids")
        .split(",")
        .map((id) => Number(id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
    : null;
  if (requestedIds && (!requestedIds.length || requestedIds.length > 100)) {
    return Response.json({ error: "invalid load_ids" }, { status: 400 });
  }

  const limit = Math.max(1, parseInt(process.env.CHECK_BATCH || "40", 10));
  const supabase = getSupabase(); // service role: the worker spans all tenants
  const nowIso = new Date().toISOString();

  try {
    let query = supabase
      .from("loads")
      .select("*")
      .is("deleted_at", null)
      .not("next_check_at", "is", null);
    if (requestedIds) {
      query = query.in("id", requestedIds).limit(requestedIds.length);
    } else {
      query = query
        .eq("tracking_enabled", true)
        .lte("next_check_at", nowIso)
        .order("next_check_at", { ascending: true })
        .limit(limit);
    }
    const { data: due, error } = await query;
    if (error) throw error;

    const results = [];
    const byUser = groupBy(due || [], (l) => l.user_id);
    let deferred = 0;

    // Stop before Vercel does.
    //
    // Rows are processed one at a time and each makes several HTTP calls
    // (share link, ORS, Mapbox, sometimes history). At CHECK_BATCH=40 that is
    // ~200 sequential calls — fine at 300ms each, over the 60s limit at 500ms.
    // A timeout would kill the invocation mid-row: the rows already done keep
    // their results, the rest are silently skipped, and nothing records that
    // the sweep was cut short.
    //
    // Yielding voluntarily is strictly better. Whatever we do not reach keeps
    // its past-due next_check_at and is simply first in the queue two minutes
    // later, so the work drains rather than being dropped.
    const started = Date.now();
    const defaultBudget = requestedIds ? 52000 : 45000;
    const BUDGET_MS = Number(process.env.CHECK_BUDGET_MS || defaultBudget);

    outer: for (const [userId, loads] of byUser) {
      const ctx = await userContext(supabase, userId, loads);
      for (const load of loads) {
        if (Date.now() - started > BUDGET_MS) {
          deferred = (due?.length || 0) - results.length;
          break outer;
        }
        try {
          results.push(await checkOne(supabase, load, ctx));
        } catch (e) {
          // checkOne handles its own failures, but the recovery path itself can
          // throw (a database hiccup while writing the error). Without this
          // guard one unlucky row aborts the entire sweep, so every remaining
          // load goes unchecked — and it would do so again on every tick,
          // because the same row is always first in the due queue.
          results.push({ id: load.id, position: load.position, load_number: load.load_number || null, status: "error", error: e.message, persisted: false });
        }
      }
    }

    // Check-in prompts are time-driven, not position-driven, so they're swept
    // separately from the ETA work.
    const telegram = requestedIds
      ? { sent: 0, failed: 0 }
      : await sweepTelegramNotifications(supabase);
    const checkins = requestedIds
      ? { prompted: 0, reprompted: 0 }
      : await sweepCheckins(supabase);

    // `deferred` is the number left for the next tick. A value that stays high
    // across sweeps means the batch cannot keep up — raise CHECK_BATCH, or the
    // budget, or both.
    return Response.json({
      checked: results.length,
      deferred,
      elapsedMs: Date.now() - started,
      telegram,
      checkins,
      results,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// One GPS lookup per provider and user-context batch, rather than one request
// per truck-number row.
async function userContext(supabase, userId, loads) {
  const ctx = {
    gpsByName: null,
    gpsError: null,
    motiveGpsByName: null,
    motiveGpsError: null,
    profile: null,
    tokens: [],
  };
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
  if (hasSamsaraToken(extra)) {
    try {
      const errs = [];
      ctx.gpsByName = await getVehicleGpsByName(errs, extra);
      if (errs.length && ctx.gpsByName.size === 0) ctx.gpsError = errs[0];
    } catch (e) {
      ctx.gpsError = e.message;
    }
  }
  const needsMotiveLookup =
    hasMotiveConfig() &&
    loads.some((load) => {
      if (!load.truck_number) return false;
      const motiveTruck = parseMotiveTruckNumber(load.truck_number);
      return (
        motiveTruck.explicit ||
        !ctx.gpsByName?.has(normalizeTruck(motiveTruck.number))
      );
    });
  if (needsMotiveLookup) {
    try {
      ctx.motiveGpsByName = await getMotiveVehicleGpsByName();
    } catch (e) {
      ctx.motiveGpsError = e.message;
    }
  }
  if (!hasSamsaraToken(extra)) {
    ctx.gpsError =
      "No Samsara API token on this account. Configure the shared Motive fleet for Motive truck numbers, or use a Live Share link.";
  }
  return ctx;
}

async function checkOne(supabase, load, ctx) {
  const out = {
    id: load.id,
    position: load.position,
    load_number: load.load_number || null,
  };
  try {
    // ---- 1. where is the truck? ----
    const pos = await resolvePosition(load, ctx);
    if (pos.error) return fail(supabase, load, pos.error, out, null, ctx);

    // ---- 2. where is it going? ----
    const dest = await resolveDestination(supabase, load, pos);
    if (dest.error) return fail(supabase, load, dest.error, out, pos, ctx);

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
    const speedFresh =
      typeof pos.speed === "number" &&
      (!Number.isFinite(pos.fixTimeMs) || Date.now() - pos.fixTimeMs <= 30 * 60 * 1000);
    const stationary = nearby && speedFresh && pos.speed <= STOPPED_MPH;
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

    // Nearest approach ever recorded for this stop.
    const closestMiles =
      straightMiles == null
        ? load.closest_miles
        : Math.min(straightMiles, load.closest_miles ?? Infinity);

    // Came and went.
    //
    // Sampling can miss the arrival itself; it cannot miss the shape of the
    // trip. If this truck was once within the arrival radius and is now well
    // outside it and climbing, the stop happened between two looks. Continuing
    // to measure "distance to the destination" for a truck driving away from a
    // completed stop is what produced ETAs receding into next week and rows
    // reading Late on loads delivered hours early.
    //
    // DEPARTED_MARGIN_MILES keeps GPS jitter and a lap of the yard from
    // counting as a departure.
    const departed =
      destTrusted &&
      pos.precision === "exact" &&
      straightMiles != null &&
      closestMiles != null &&
      closestMiles < ARRIVAL_NEAR_MILES &&
      straightMiles > closestMiles + DEPARTED_MARGIN_MILES;

    const arrivedClose =
      destTrusted && pos.precision === "exact" && straightMiles != null && straightMiles < ARRIVAL_MILES;
    // Older share links may not include speed; those keep the distance-only
    // arrival rule rather than never arriving.
    const arrivedDwell = destTrusted && stationary && dwelledMs >= ARRIVAL_DWELL_MS;

    // Live checks are samples, so a short stop can fall between two of them.
    // When the appointment has passed and the row still isn't closed, replay
    // the truck's breadcrumbs once and ask whether it was ever parked there.
    let backfill = null;
    if (!arrivedClose && !arrivedDwell && destTrusted) {
      backfill = await historyBackfill(load, dest, ctx);
    }

    if (arrivedClose || arrivedDwell || backfill || departed) {
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
          telegram_pending_status: "arrived",
          // Say which rule fired: "arrived" a quarter-mile from the pin looks
          // like a bug unless the row explains that the truck has been parked
          // there for twenty minutes.
          closest_miles: closestMiles,
          status_note: arrivedClose
            ? null
            : departed && !backfill
            ? `Delivered between checks — came within ${Number(closestMiles).toFixed(
                2
              )} mi and has since moved on.`
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
      { timeZone: tz, allowTruckRouting: destTrusted }
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
        telegram_pending_status:
          status === "late" && load.status !== "late"
            ? "late"
            : load.telegram_pending_status ?? null,
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
        closest_miles: closestMiles,
        checkin_due_at: checkinDueAt(load, tz),
        // Remaining drive time matters as much as slack: a truck 20 minutes
        // out is about to arrive whatever its buffer, and missing that moment
        // is how a row ends up measuring the distance to a stop it already
        // completed and left.
        next_check_at: load.tracking_enabled === false
          ? null
          : nextCheckAt({ slackMs: slack, etaMs: est.seconds * 1000 }),
      },
      pos,
    });
  } catch (e) {
    return fail(supabase, load, e.message?.slice(0, 200) || "check failed", out, null, ctx);
  }
}

// Truck numbers resolve against Samsara then Motive; share links use their
// provider-specific readers.
async function resolvePosition(load, ctx) {
  if (load.truck_number) {
    const motiveTruck = parseMotiveTruckNumber(load.truck_number);
    const lookupNumber = normalizeTruck(motiveTruck.number);
    const samsaraGps = motiveTruck.explicit
      ? null
      : ctx.gpsByName?.get(lookupNumber);
    if (samsaraGps) {
      return {
        lat: samsaraGps.lat,
        lng: samsaraGps.lng,
        formatted: samsaraGps.formatted,
        source: "samsara_api",
        precision: "exact",
        tier: null,
        speed: samsaraGps.speed,
        fixTimeMs: samsaraGps.time ? Date.parse(samsaraGps.time) : null,
      };
    }

    const motiveGps = ctx.motiveGpsByName?.get(lookupNumber);
    if (motiveGps) {
      if (
        !Number.isFinite(motiveGps.lat) ||
        motiveGps.lat < -90 ||
        motiveGps.lat > 90 ||
        !Number.isFinite(motiveGps.lng) ||
        motiveGps.lng < -180 ||
        motiveGps.lng > 180
      ) {
        return {
          error: `Motive found truck ${motiveTruck.number}, but Motive did not return a usable current location.`,
        };
      }
      return {
        lat: motiveGps.lat,
        lng: motiveGps.lng,
        formatted: motiveGps.formatted,
        source: "motive_api",
        precision: "exact",
        tier: null,
        speed: motiveGps.speed,
        motion: motiveGps.motion,
        fixTimeMs: motiveGps.time ? Date.parse(motiveGps.time) : null,
      };
    }

    if (motiveTruck.explicit && !hasMotiveConfig()) {
      return {
        error:
          "Motive truck numbers require a shared Motive fleet. Set MOTIVE_API or MOTIVE_API_KEY in Vercel or connect Motive with OAuth from /admin.",
      };
    }
    if (ctx.motiveGpsError) {
      return { error: ctx.motiveGpsError };
    }
    if (ctx.gpsError && !hasMotiveConfig()) return { error: ctx.gpsError };
    if (hasMotiveConfig()) {
      return {
        error: `Truck ${motiveTruck.number} not found in the connected Samsara or Motive fleet. Check the fleet number and Motive access.`,
      };
    }
    if (ctx.gpsError) return { error: ctx.gpsError };
    return {
      error: "Truck not found in the connected Samsara account. For a Motive truck, configure the shared Motive fleet and enter it as Motive: 123.",
    };
  }

  if (load.samsara_url) {
    const motive = parseMotiveUrl(load.samsara_url);
    const share = motive
      ? await fetchMotiveLocation(load.samsara_url)
      : await fetchShareLocation(load.samsara_url);
    return {
      lat: share.lat,
      lng: share.lng,
      formatted: share.formatted,
      source: motive ? "motive_share" : "graphql",
      precision: "exact",
      tier: motive ? 2 : 1,
      speed: share.speed,
      motion: share.motion,
      fixTimeMs: share.fixTimeMs,
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
  const motion = motionForPosition(load, pos);
  await writeTrackingResult(supabase, load.id, {
      // Any successful check ends the failure streak. Without this the counter
      // would accumulate across unrelated outages and eventually make a healthy
      // row give up over failures it had already recovered from.
      fail_count: 0,
      // A link that comes back to life is allowed to raise the alarm again if
      // it dies a second time.
      blackout_alerted: false,
      ...patch,
      truck_at: pos?.formatted ?? load.truck_at,
      last_lat: pos?.lat ?? load.last_lat,
      last_lng: pos?.lng ?? load.last_lng,
      last_place: pos?.formatted ?? load.last_place,
      position_source: pos?.source ?? load.position_source,
      position_precision: pos?.precision ?? load.position_precision,
      link_tier: pos?.tier ?? load.link_tier,
      motion: motion.motion,
      motion_updated_at: motion.updatedAt,
      updated_at: new Date().toISOString(),
    });
  return rest;
}

function motionForPosition(load, pos) {
  const previous = load.motion || null;
  const previousAt = load.motion_updated_at || null;
  const speedFresh =
    typeof pos?.speed === "number" &&
    (!Number.isFinite(pos.fixTimeMs) || Date.now() - pos.fixTimeMs <= 30 * 60 * 1000);
  const fixAt =
    Number.isFinite(pos?.fixTimeMs) && pos.fixTimeMs > 0
      ? new Date(pos.fixTimeMs).toISOString()
      : new Date().toISOString();
  if (speedFresh && Number.isFinite(pos.speed)) {
    return {
      motion: pos.speed > STOPPED_MPH ? "Rolling" : "Stopped",
      updatedAt: fixAt,
    };
  }
  if (
    typeof pos?.speed === "number" &&
    Number.isFinite(pos.speed) &&
    !previous
  ) {
    return {
      motion: pos.speed > STOPPED_MPH ? "Rolling" : "Stopped",
      updatedAt: fixAt,
    };
  }
  if (pos?.motion === "Rolling" || pos?.motion === "Stopped") {
    return { motion: pos.motion, updatedAt: fixAt };
  }
  if (pos?.lat != null && pos?.lng != null && load.last_lat != null && load.last_lng != null) {
    const movedMiles = haversineMiles(
      { lat: load.last_lat, lng: load.last_lng },
      { lat: pos.lat, lng: pos.lng }
    );
    if (movedMiles != null && movedMiles > 0.1) {
      return { motion: "Rolling", updatedAt: fixAt };
    }
  }
  return { motion: previous, updatedAt: previousAt };
}

// Failures that will never fix themselves on a retry. Re-checking these is
// pure waste — the row needs a person, not another attempt.
const PERMANENT_FAILURES = [
  /not a recognizable (?:samsara|motive).*share link/i,
  /add a truck # or .*share link/i,
  /destination required/i,
  /share link returned no data/i, // expired or revoked link
  /motive share returned no usable vehicle location/i,
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
async function fail(supabase, load, note, out, pos = null, ctx = null) {
  const text = String(note);
  const permanent = PERMANENT_FAILURES.some((re) => re.test(text));
  const fails = (load.fail_count || 0) + 1;
  const exhausted = fails >= MAX_FAILS;
  const giveUp = permanent || exhausted;

  // 30m, 1h, 2h, 4h, 8h — capped so it never schedules absurdly far out.
  const backoffMs = Math.min(30 * 60 * 1000 * 2 ** (fails - 1), 8 * 60 * 60 * 1000);

  const suffix = permanent
    ? " Fix the row and turn Track on, or use Update all now."
    : exhausted
    ? ` Stopped after ${fails} failed attempts — fix the row and turn Track on, or use Update all now.`
    : "";

  // Tell someone the load has gone dark.
  //
  // Only when tracking has actually STOPPED (giveUp), only for a row that was
  // working before — `eta_iso` proves at least one successful check — and only
  // once. A row that never tracked was already reported at save time, so
  // emailing about it again would just be noise. A load that has arrived, or is
  // already closed, needs no alarm.
  let blackoutAlerted = load.blackout_alerted;
  const wasTracking = !!load.eta_iso || load.last_lat != null;
  const alertOn = load.alert_enabled !== false;
  if (giveUp && wasTracking && alertOn && !load.arrived_at && !load.blackout_alerted) {
    const to = recipientsFor(ctx?.profile, "alert");
    if (to.length) {
      try {
        const tz = tzFromCoords(load.dest_lat, load.dest_lng) || FALLBACK_TZ;
        const res = await sendTrackingLostEmail({
          to,
          load: { ...load, timeZone: tz },
          reason: text.slice(0, 180),
        });
        if (res.sent.length > 0) blackoutAlerted = true;
      } catch (e) {
        // Never let the alert failure hide the underlying problem — the row
        // still records why tracking stopped.
        out.blackoutEmailError = String(e.message).slice(0, 150);
      }
    }
  }

  await writeTrackingResult(supabase, load.id, {
      status: "error",
      status_note: (text.slice(0, 200 - suffix.length) + suffix).slice(0, 200),
      fail_count: fails,
      blackout_alerted: blackoutAlerted,
      next_check_at:
        giveUp || load.tracking_enabled === false
          ? null
          : new Date(Date.now() + backoffMs).toISOString(),
      last_lat: pos?.lat ?? load.last_lat,
      last_lng: pos?.lng ?? load.last_lng,
      last_place: pos?.formatted ?? load.last_place,
      updated_at: new Date().toISOString(),
    });
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
    .is("deleted_at", null)
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
      .eq("id", load.id)
      .is("deleted_at", null);
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

// Status-change reports are sent once per load. Periodic Telegram updates are
// no longer configured per row; Track controls scheduled checks.
async function sweepTelegramNotifications(supabase) {
  const pending = [];
  const { data: events, error: eventError } = await supabase
    .from("loads")
    .select("*")
    .is("deleted_at", null)
    .in("telegram_pending_status", ["late", "arrived"])
    .limit(50);
  if (eventError) {
    console.warn("Telegram status notification query failed:", eventError.message);
    return { sent: 0, failed: 1 };
  }
  pending.push(...(events || []).map((load) => ({ load, event: true })));

  const profiles = new Map();
  let sent = 0;
  let failed = 0;
  for (const { load, event } of pending) {
    try {
      let profile = profiles.get(load.user_id);
      if (!profile) {
        const { data } = await supabase
          .from("profiles")
          .select("telegram_chat_id")
          .eq("id", load.user_id)
          .maybeSingle();
        profile = data || null;
        profiles.set(load.user_id, profile);
      }
      if (!profile?.telegram_chat_id) continue;
      const eventStatus = event ? load.telegram_pending_status : null;
      const status = eventStatus || load.status;
      await sendTelegramLoadReport(profile.telegram_chat_id, load, status);

      const now = new Date();
      const patch = { telegram_last_sent_at: now.toISOString() };
      if (eventStatus === "late") patch.telegram_late_notified_at = now.toISOString();
      if (eventStatus === "arrived") {
        patch.telegram_arrived_notified_at = now.toISOString();
        patch.telegram_next_at = null;
      }
      if (eventStatus) patch.telegram_pending_status = null;

      let update = supabase
        .from("loads")
        .update(patch)
        .eq("id", load.id)
        .is("deleted_at", null);
      if (eventStatus) update = update.eq("telegram_pending_status", eventStatus);
      const { error } = await update;
      if (error) throw error;
      sent++;
    } catch (e) {
      failed++;
      console.warn(`Telegram notification failed for load ${load.id}:`, e.message);
    }
  }
  return { sent, failed };
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
