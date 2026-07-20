import { getSupabase } from "../../../lib/supabase";
import {
  getVehicleGpsByName,
  hasSamsaraToken,
  normalizeTruck,
  localToIso,
  formatEta,
} from "../../../lib/samsara";
import { geocode, drivingEtaSeconds } from "../../../lib/maps";
import { scrapeLiveShare, parseEtaToIso } from "../../../lib/liveshare";
import { sendLateEmail } from "../../../lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/check?key=CHECK_SECRET
// Hybrid refresh:
//  - Truck# loads: read live GPS from Samsara + compute ETA via Mapbox (all, every run).
//  - Live Share loads: scrape the pasted link's ETA (a small batch per run).
// Then compare each to its deadline and email newly-late loads.
export async function GET(req) {
  const reqUrl = new URL(req.url);
  const secret = process.env.CHECK_SECRET;
  const keyOk = !secret || reqUrl.searchParams.get("key") === secret;
  const origin = req.headers.get("origin") || req.headers.get("referer") || "";
  let sameSite = false;
  try {
    sameSite = origin ? new URL(origin).host === reqUrl.host : false;
  } catch (_) {}
  if (!keyOk && !sameSite) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const graceMs =
    Math.max(0, parseInt(process.env.LATE_GRACE_MIN || "0", 10)) * 60000;
  const linkBatch = Math.max(
    0,
    parseInt(process.env.CHECK_BATCH_LINKS || "2", 10)
  );

  try {
    const supabase = getSupabase();

    const { data: settings } = await supabase
      .from("settings")
      .select("timezone")
      .eq("id", 1)
      .maybeSingle();
    // Notification recipient is fixed via env (no per-user entry).
    const notifyEmail = process.env.NOTIFY_EMAIL || null;
    const timezone = settings?.timezone || "America/Chicago";

    const { data: loads, error } = await supabase
      .from("loads")
      .select("*")
      .not("deadline", "is", null);
    if (error) throw error;

    const truckLoads = (loads || []).filter((l) => l.truck_number);
    const linkLoads = (loads || [])
      .filter((l) => l.samsara_url)
      .sort((a, b) => (a.updated_at || "").localeCompare(b.updated_at || ""))
      .slice(0, linkBatch);

    const now = Date.now();
    const results = [];

    // ---- Truck # loads (Samsara API + Mapbox) ----
    if (truckLoads.length > 0) {
      if (!hasSamsaraToken()) {
        for (const load of truckLoads) {
          await update(supabase, load.position, {
            status: "error",
            status_note: "No Samsara API token configured",
          });
          results.push({ position: load.position, status: "error", error: "no token" });
        }
      } else {
        const tokenErrors = [];
        const gpsByName = await getVehicleGpsByName(tokenErrors);
        for (const load of truckLoads) {
          const out = await checkTruckLoad(
            supabase,
            load,
            gpsByName,
            timezone,
            graceMs,
            now,
            notifyEmail
          );
          results.push(out);
        }
        if (tokenErrors.length) results.push({ tokenErrors });
      }
    }

    // ---- Live Share loads (scrape) ----
    for (const load of linkLoads) {
      const out = await checkLinkLoad(
        supabase,
        load,
        timezone,
        graceMs,
        notifyEmail
      );
      results.push(out);
    }

    return Response.json({
      checked: truckLoads.length + linkLoads.length,
      truckLoads: truckLoads.length,
      linkLoadsChecked: linkLoads.length,
      notifyEmail: notifyEmail ? "set" : "missing",
      timezone,
      results,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

async function checkTruckLoad(
  supabase,
  load,
  gpsByName,
  timezone,
  graceMs,
  now,
  notifyEmail
) {
  const out = { position: load.position, truck: load.truck_number };
  try {
    const gps = gpsByName.get(normalizeTruck(load.truck_number));
    if (!gps) {
      await update(supabase, load.position, {
        status: "error",
        status_note: "Truck not found in any connected Samsara account",
      });
      return { ...out, status: "error", error: "truck not found" };
    }
    if (!load.destination) {
      await update(supabase, load.position, {
        status: "error",
        status_note: "Destination required for truck # loads",
        truck_at: gps.formatted,
      });
      return { ...out, status: "error", error: "no destination" };
    }

    let dest =
      load.dest_lat != null && load.dest_lng != null
        ? { lat: load.dest_lat, lng: load.dest_lng }
        : await geocode(load.destination);
    if (!dest) {
      await update(supabase, load.position, {
        status: "error",
        status_note: "Could not locate destination address",
        truck_at: gps.formatted,
      });
      return { ...out, status: "error", error: "geocode failed" };
    }

    const etaSec = await drivingEtaSeconds({ lat: gps.lat, lng: gps.lng }, dest);
    const etaIso = new Date(now + etaSec * 1000).toISOString();
    const etaDisplay = formatEta(etaIso, timezone);
    const deadlineIso = localToIso(load.deadline, timezone);

    return finalize(supabase, load, {
      etaIso,
      etaDisplay,
      deadlineIso,
      graceMs,
      truck_at: gps.formatted,
      notifyEmail,
      extra: { dest_lat: dest.lat, dest_lng: dest.lng },
      out,
    });
  } catch (e) {
    await update(supabase, load.position, {
      status: "error",
      status_note: e.message?.slice(0, 200) || "check failed",
    });
    return { ...out, status: "error", error: e.message };
  }
}

async function checkLinkLoad(supabase, load, timezone, graceMs, notifyEmail) {
  const out = { position: load.position, link: true };
  try {
    const { etaText, etaIso, destination } = await scrapeLiveShare(
      load.samsara_url
    );
    const etaDisplay = etaText; // already a readable clock time like "6:15 AM CDT"
    const deadlineIso = localToIso(load.deadline, timezone);
    return finalize(supabase, load, {
      etaIso: etaIso || parseEtaToIso(etaText),
      etaDisplay,
      deadlineIso,
      graceMs,
      truck_at: destination ? `Dest: ${destination}` : null,
      notifyEmail,
      extra: {},
      out,
    });
  } catch (e) {
    await update(supabase, load.position, {
      status: "error",
      status_note: e.message?.slice(0, 200) || "link check failed",
    });
    return { ...out, status: "error", error: e.message };
  }
}

// Shared: compute late/on-time, email if newly late, persist.
async function finalize(
  supabase,
  load,
  { etaIso, etaDisplay, deadlineIso, graceMs, truck_at, notifyEmail, extra, out }
) {
  let status = "unknown";
  if (etaIso && deadlineIso) {
    status =
      new Date(etaIso).getTime() > new Date(deadlineIso).getTime() + graceMs
        ? "late"
        : "on_time";
  }

  const wasLate = load.status === "late";
  const nowLate = status === "late";
  let alerted = load.alerted;
  const result = { ...out, status, eta: etaDisplay };

  if (nowLate && !load.alerted && notifyEmail) {
    try {
      await sendLateEmail({
        to: notifyEmail,
        load: { ...load, eta_display: etaDisplay, truck_at },
      });
      alerted = true;
      result.emailed = true;
    } catch (e) {
      result.emailError = e.message;
    }
  }
  if (!nowLate && wasLate) alerted = false;

  await update(supabase, load.position, {
    ...extra,
    eta_iso: etaIso,
    eta_display: etaDisplay,
    truck_at,
    status,
    status_note: null,
    alerted,
  });
  return result;
}

async function update(supabase, position, fields) {
  await supabase
    .from("loads")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("position", position);
}
