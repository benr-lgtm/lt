import { getSupabase } from "../../../lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health — quick diagnostics for setup.
// GET /api/health?write=1 — additionally attempts a real upsert (same code path
// as Save) into position 29 and reports the exact database error, if any.
export async function GET(req) {
  const wantWrite = new URL(req.url).searchParams.get("write") === "1";
  return health(wantWrite);
}

async function health(wantWrite) {
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
      // Select every column the app writes, so a missing column is caught here.
      const { error } = await supabase
        .from("loads")
        .select(
          "id,position,name,truck_number,samsara_url,kind,deadline,destination,dest_lat,dest_lng,eta_iso,eta_display,truck_at,status,status_note,alerted,updated_at"
        )
        .limit(1);
      database = error ? `error: ${error.message}` : "ok";
    }
  } catch (e) {
    database = `error: ${e.message}`;
  }

  let writeTest = "skipped (add ?write=1)";
  if (wantWrite && database === "ok") {
    try {
      const supabase = getSupabase();
      const { error } = await supabase
        .from("loads")
        .upsert(
          [
            {
              position: 29,
              name: "health write test",
              kind: "delivery",
              updated_at: new Date().toISOString(),
            },
          ],
          { onConflict: "position" }
        );
      writeTest = error ? `error: ${error.message}` : "ok";
    } catch (e) {
      writeTest = `error: ${e.message}`;
    }
  }

  const hints = [];
  if (typeof writeTest === "string" && writeTest.includes("ON CONFLICT"))
    hints.push(
      "Missing unique constraint on position. Run: create unique index if not exists loads_position_key on public.loads(position);"
    );
  if (typeof writeTest === "string" && /row-level security/i.test(writeTest))
    hints.push(
      "RLS is blocking writes. Run: alter table public.loads disable row level security; and confirm SUPABASE_SERVICE_ROLE_KEY is the service_role (secret) key."
    );
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
    writeTest,
    env,
    hints,
  });
}
