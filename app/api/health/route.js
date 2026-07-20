import { getSupabase } from "../../../lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health — quick diagnostics for setup.
// Visit https://YOUR-APP.vercel.app/api/health to see what's configured.
export async function GET() {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    SAMSARA_API_TOKEN:
      !!process.env.SAMSARA_API_TOKEN || !!process.env.SAMSARA_API_TOKENS,
    MAPBOX_TOKEN: !!process.env.MAPBOX_TOKEN,
    GOOGLE_MAPS_KEY: !!process.env.GOOGLE_MAPS_KEY,
    RESEND_API_KEY: !!process.env.RESEND_API_KEY,
    NOTIFY_EMAIL: !!process.env.NOTIFY_EMAIL,
    CHECK_SECRET: !!process.env.CHECK_SECRET,
  };

  let database = "unknown";
  try {
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      database = "missing Supabase env vars";
    } else {
      const supabase = getSupabase();
      const { error } = await supabase.from("loads").select("id").limit(1);
      database = error ? `error: ${error.message}` : "ok";
    }
  } catch (e) {
    database = `error: ${e.message}`;
  }

  const hints = [];
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
    hints.push("Add Supabase env vars in Vercel, then redeploy.");
  if (typeof database === "string" && database.includes("does not exist"))
    hints.push("Run supabase-schema.sql in the Supabase SQL editor.");
  if (!env.SAMSARA_API_TOKEN) hints.push("Add SAMSARA_API_TOKEN for truck# loads.");
  if (!env.MAPBOX_TOKEN) hints.push("Add MAPBOX_TOKEN for ETA calculation.");
  if (!env.NOTIFY_EMAIL || !env.RESEND_API_KEY)
    hints.push("Add RESEND_API_KEY and NOTIFY_EMAIL for alerts.");

  return Response.json({
    ok: database === "ok",
    database,
    env,
    hints,
  });
}
