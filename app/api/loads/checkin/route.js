import { getSessionUser, unauthorized } from "../../../../lib/supabaseServer";
import { getSupabase } from "../../../../lib/supabase";
import { chargeForRow } from "../../../../lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { loadId, state: "checked_in" | "missed" }
//
// "checked_in" ends the row's life: the stop is complete, so we stop scheduling
// it and bill the $2 here. "missed" leaves it red and lets the cron keep
// re-prompting every 15 minutes until someone resolves it — and bills nothing,
// because a missed check-in is not a completed stop.
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
  // Selecting the updated row back means the charge below can only ever run for
  // a row the caller actually owns — the ledger write uses the service role, so
  // it must not take the client's word for which row this is.
  const { data: updated, error } = await supabase
    .from("loads")
    .update(patch)
    .eq("id", loadId)
    .select("*")
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!updated) return Response.json({ error: "Load not found." }, { status: 404 });

  // Check-in is a completion, so this is where a checked-in row is billed. A
  // row that already arrived was charged then; chargeForRow is idempotent
  // against a unique index, so the second attempt is a no-op rather than a
  // double charge.
  let charged = false;
  if (state === "checked_in" && !updated.charged_at) {
    try {
      const res = await chargeForRow(getSupabase(), updated);
      charged = res.charged;
    } catch (e) {
      // A billing failure must never block the driver's check-in from being
      // recorded — the operational fact is worth more than the ledger line,
      // and the row keeps charged_at null so it can be picked up later.
      console.warn(`[checkin] charge failed for load ${loadId}: ${e.message}`);
    }
  }

  return Response.json({ ok: true, charged });
}
