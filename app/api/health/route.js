import { getSupabase } from "../../../lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health — public, and deliberately reports only whether things are
// SET, never their values. Exists because the most common failure mode is a
// missing env var surfacing as an opaque 500 somewhere unrelated.
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

  let db = { ok: false, error: null, due: null };
  try {
    const supabase = getSupabase();
    const { count, error } = await supabase
      .from("loads")
      .select("id", { count: "exact", head: true })
      .not("next_check_at", "is", null)
      .lte("next_check_at", new Date().toISOString());
    if (error) throw error;
    // A number that stays high means the cron isn't reaching /api/check.
    db = { ok: true, error: null, due: count ?? 0 };
  } catch (e) {
    db = { ok: false, error: e.message, due: null };
  }

  return Response.json(
    { ok: db.ok && missing.length === 0, env, missing, db },
    { status: db.ok ? 200 : 500 }
  );
}
