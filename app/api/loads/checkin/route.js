import { getSessionUser, unauthorized } from "../../../../lib/supabaseServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { loadId, state: "checked_in" | "missed" }
//
// "checked_in" ends the row's life: the $2 covered tracking through this point,
// so we stop scheduling it. "missed" leaves it red and lets the cron keep
// re-prompting every 15 minutes until someone resolves it.
export async function POST(req) {
  const session = await getSessionUser();
  if (!session) return unauthorized();
  const { supabase } = session;

  const { loadId, state } = await req.json().catch(() => ({}));
  if (!["checked_in", "missed"].includes(state)) {
    return Response.json({ error: "Bad state." }, { status: 400 });
  }

  const patch = {
    checkin_state: state,
    checkin_prompted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Only stop tracking when the stop is genuinely complete.
  if (state === "checked_in") patch.next_check_at = null;

  // RLS scopes this to the caller's own rows; the id alone is not authority.
  const { error } = await supabase.from("loads").update(patch).eq("id", loadId);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ ok: true });
}
