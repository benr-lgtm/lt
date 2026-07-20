import { getSupabase } from "../../../lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/settings -> { timezone }
// The notification email is fixed via the NOTIFY_EMAIL env var, not stored here.
export async function GET() {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("settings")
      .select("timezone")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw error;
    return Response.json({ timezone: data?.timezone || "America/Chicago" });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// PUT /api/settings  Body: { timezone }
export async function PUT(req) {
  try {
    const supabase = getSupabase();
    const body = await req.json();
    const timezone = (body.timezone || "America/Chicago").trim();
    const { error } = await supabase.from("settings").upsert({
      id: 1,
      timezone,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    return Response.json({ timezone });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
