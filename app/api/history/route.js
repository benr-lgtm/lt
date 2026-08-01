import { getSessionUser, unauthorized } from "../../../lib/supabaseServer";
import { tzFromCoords } from "../../../lib/samsara";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How long a cleared load stays readable. Must match purge_old_loads() in the
// database, which is what actually removes them.
export const RETENTION_DAYS = 7;

const LIMIT = 300;

// GET /api/history -> past loads (7 days) + the full billing record.
//
// Two different retention policies live side by side here, deliberately:
//
//   loads               kept 7 days, then deleted
//   credit_transactions kept forever
//
// That is why a charge records the truck number and destination as TEXT when it
// is made rather than relying on a join — the ledger has to still read
// correctly after the load row it refers to is gone. A statement from March
// must be legible in December.
export async function GET() {
  const session = await getSessionUser();
  if (!session) return unauthorized();
  const { supabase, profile } = session;

  const since = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();

  // Everything finished or cleared: retired rows, plus completed ones still on
  // the board. A dispatcher looking for "what did we run yesterday" does not
  // care which of those two a row happens to be.
  const { data: loads, error } = await supabase
    .from("loads")
    .select(
      "id,position,name,kind,truck_number,samsara_url,destination,notes,appt_at,deadline," +
        "status,status_note,eta_display,eta_iso,dest_lat,dest_lng,miles_left,last_place," +
        "arrived_at,checkin_state,charged_at,deleted_at,updated_at"
    )
    .or(`deleted_at.not.is.null,arrived_at.not.is.null`)
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(LIMIT);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const { data: tx } = await supabase
    .from("credit_transactions")
    .select("id,amount_cents,kind,load_id,note,created_at")
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  // Monthly totals, computed from the permanent ledger rather than from loads,
  // so the summary survives the 7-day purge.
  const months = new Map();
  for (const t of tx || []) {
    const key = String(t.created_at).slice(0, 7);
    const m = months.get(key) || { month: key, spent_cents: 0, topped_up_cents: 0, loads: 0 };
    if (t.amount_cents < 0) {
      m.spent_cents += -t.amount_cents;
      m.loads += 1;
    } else {
      m.topped_up_cents += t.amount_cents;
    }
    months.set(key, m);
  }

  return Response.json({
    balance_cents: profile?.balance_cents ?? 0,
    retentionDays: RETENTION_DAYS,
    loads: (loads || []).map((l) => ({
      ...l,
      // Computed from the coordinates by an offline lookup — there is no
      // dest_tz column, and asking Postgres for one is what broke this page.
      dest_tz: tzFromCoords(l.dest_lat, l.dest_lng),
      cleared: !!l.deleted_at,
      // Days left before this row is purged — shown so nobody assumes the
      // archive is permanent.
      expiresInDays: l.deleted_at
        ? Math.max(
            0,
            RETENTION_DAYS - Math.floor((Date.now() - new Date(l.deleted_at).getTime()) / 86400000)
          )
        : null,
    })),
    entries: tx || [],
    months: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)),
  });
}
