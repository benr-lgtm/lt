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

  const now = new Date().toISOString();
  const patch = {
    checkin_state: state,
    checkin_prompted_at: now,
    updated_at: now,
  };

  if (state === "checked_in") {
    // Only stop tracking when the stop is genuinely complete.
    patch.next_check_at = null;

    // ...and say so on the row.
    //
    // This previously stopped tracking and took the money but left `status`
    // untouched, so a row froze at whatever the last ETA check had decided.
    // Loads that were delivered ON TIME sat there reading "Late" indefinitely —
    // finished, paid for, tracking stopped, and still showing an alarm. The
    // driver confirming they are at the facility is better evidence of arrival
    // than any distance calculation, so it is recorded as one.
    patch.status = "arrived";
    patch.status_note = "Closed by driver check-in.";
    patch.miles_left = 0;
    patch.alerted = false;
  }

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

  // Stamp the arrival time only if GPS hadn't already caught it, so a real
  // detected arrival keeps its own (earlier, more accurate) timestamp.
  if (state === "checked_in" && !updated.arrived_at) {
    await supabase.from("loads").update({ arrived_at: now }).eq("id", loadId).is("arrived_at", null);
  }

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
