import { getSupabase } from "../../../lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health — public, and deliberately reports only whether things are
// SET, never their values. Exists because the most common failure mode is a
// missing env var surfacing as an opaque 500 somewhere unrelated.
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
      // Far and away the most likely reason someone reports "no emails arrive".
      warning: /resend\.dev/.test(process.env.RESEND_FROM || "")
        ? "Using the shared resend.dev sender — it only delivers to the Resend account owner. Verify a domain before inviting users."
        : null,
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
