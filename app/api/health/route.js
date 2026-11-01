import { getSupabase } from "../../../lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health — public, and deliberately reports only whether things are
// SET, never their values. Exists because the most common failure mode is a
// missing env var surfacing as an opaque 500 somewhere unrelated.
// How far behind the checker may fall before this endpoint calls it broken.
// The cron fires every 2 minutes and sweeps 40 rows a tick, so 15 minutes is
// several times any legitimate backlog — high enough never to cry wolf during a
// bulk save, low enough to catch a dead cron within one alert cycle.
const STALL_MINUTES = Number(process.env.HEALTH_STALL_MINUTES || 15);

// "TruckOn <alerts@truckon.site>" -> "TruckOn". Safe to expose: it is on the
// From line of every email already.
function senderName(from) {
  if (!from) return null;
  const m = String(from).match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : String(from).trim();
}

// The display name should look like the product. Anything else is almost
// certainly a leftover from a rename that never reached the environment.
function staleBrandWarning(from) {
  const name = senderName(from);
  if (!name) return null;
  if (/truckon/i.test(name)) return null;
  return `Emails are being sent as "${name}", which doesn't look like TruckOn. RESEND_FROM lives in the environment, not the code — update it in your hosting provider's environment variables.`;
}

export async function GET() {
  const set = (k) => ({ set: !!process.env[k] });

  const env = {
    NEXT_PUBLIC_SUPABASE_URL: set("NEXT_PUBLIC_SUPABASE_URL"),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: set("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    SUPABASE_SERVICE_ROLE_KEY: set("SUPABASE_SERVICE_ROLE_KEY"),
    // MAPBOX_TOKEN is now the primary router, not a final-approach extra, so a
    // missing one degrades every ETA to the ORS fallback rather than a few.
    MAPBOX_TOKEN: set("MAPBOX_TOKEN"),
    ORS_API_KEY: set("ORS_API_KEY"),
    MOTIVE_OAUTH: {
      set: !!(
        process.env.MOTIVE_CLIENT_ID &&
        process.env.MOTIVE_CLIENT_SECRET &&
        process.env.MOTIVE_REDIRECT_URI
      ),
      required: false,
    },
    // Reported but not required: the last-resort geocoder, only reached when
    // both Nominatim and ORS fail on an address. Its absence was previously
    // invisible here, which made "why did this address never resolve?"
    // needlessly hard to answer.
    GOOGLE_MAPS_KEY: {
      set: !!process.env.GOOGLE_MAPS_KEY,
      required: false,
      note: process.env.GOOGLE_MAPS_KEY
        ? null
        : "Not set — messy addresses that Nominatim and ORS both miss will fail to geocode.",
    },
    RESEND_API_KEY: set("RESEND_API_KEY"),
    RESEND_FROM: {
      set: !!process.env.RESEND_FROM,
      value: senderName(process.env.RESEND_FROM),
      // Far and away the most likely reason someone reports "no emails arrive".
      warning: /resend\.dev/.test(process.env.RESEND_FROM || "")
        ? "Using the shared resend.dev sender — it only delivers to the Resend account owner. Verify a domain before inviting users."
        : // The display name is what recipients actually see, and it lives in
          // the environment rather than the code — so renaming the app does not
          // change it, and a stale name can sit in production indefinitely
          // looking correct from the inside. Surface the mismatch here.
          staleBrandWarning(process.env.RESEND_FROM),
    },
    ENCRYPTION_KEY: set("ENCRYPTION_KEY"),
    CHECK_SECRET: set("CHECK_SECRET"),
    ADMIN_PASSWORD: set("ADMIN_PASSWORD"),
    ADMIN_SECRET: set("ADMIN_SECRET"),
    NEXT_PUBLIC_APP_URL: set("NEXT_PUBLIC_APP_URL"),
  };

  // `required: false` entries are reported for visibility but must not fail the
  // health check — otherwise an optional fallback being absent would light up
  // the same alarm as a missing database key.
  const missing = Object.entries(env)
    .filter(([, v]) => !v.set && v.required !== false)
    .map(([k]) => k);

  let db = { ok: false, error: null, due: null, oldestDueMinutes: null, stalled: false };
  try {
    const supabase = getSupabase();
    const nowIso = new Date().toISOString();

    const { count, error } = await supabase
      .from("loads")
      .select("id", { count: "exact", head: true })
      .not("next_check_at", "is", null)
      .lte("next_check_at", nowIso);
    if (error) throw error;

    // How far behind is the WORST row? This, not the count, is the signal.
    //
    // A backlog is normal for a moment: saving twenty loads makes twenty rows
    // due at once and the sweep clears 40 per tick, so `due` spikes and drains.
    // What cannot happen while the cron is alive is a row sitting overdue for
    // a quarter of an hour — the job fires every two minutes.
    const { data: oldest } = await supabase
      .from("loads")
      .select("next_check_at")
      .not("next_check_at", "is", null)
      .lte("next_check_at", nowIso)
      .order("next_check_at", { ascending: true })
      .limit(1);

    const oldestAt = oldest?.[0]?.next_check_at ? new Date(oldest[0].next_check_at) : null;
    const oldestDueMinutes = oldestAt
      ? Math.round((Date.now() - oldestAt.getTime()) / 60000)
      : null;

    db = {
      ok: true,
      error: null,
      due: count ?? 0,
      oldestDueMinutes,
      // Nothing due at all is healthy — an idle fleet is not a broken one.
      stalled: oldestDueMinutes != null && oldestDueMinutes >= STALL_MINUTES,
    };
  } catch (e) {
    db = { ok: false, error: e.message, due: null, oldestDueMinutes: null, stalled: false };
  }

  // The reason this endpoint is worth pointing a monitor at.
  //
  // "Is the site up?" was never the interesting question — Vercel does not
  // sleep, and the pages would serve happily while no load was being checked.
  // The dangerous failure is the CRON dying: rows quietly stop updating, no
  // error appears anywhere, and the table still looks correct. Reporting that
  // as a non-2xx is what lets an uptime monitor catch it with no extra config.
  const problem = db.stalled
    ? `Tracking has stalled — the oldest row has been due for ${db.oldestDueMinutes} minutes, ` +
      `but the checker should run every couple of minutes. Verify the pg_cron job ` +
      `(select * from cron.job) and public.worker_config.enabled.`
    : null;

  const ok = db.ok && missing.length === 0 && !db.stalled;
  return Response.json(
    { ok, problem, env, missing, db },
    // 500 = we cannot even reach the database. 503 = reachable, but the work
    // is not getting done. Both read as "down" to a monitor; the distinction
    // is for whoever opens the page afterwards.
    { status: !db.ok ? 500 : db.stalled ? 503 : 200 }
  );
}
