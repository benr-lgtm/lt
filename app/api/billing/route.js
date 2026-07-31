import { getSessionUser, unauthorized } from "../../../lib/supabaseServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How many ledger lines to hand the UI. Enough to cover a heavy month without
// turning the balance panel into a data export.
const LIMIT = 200;

// GET /api/billing -> this account's ledger.
//
// Everything here runs on the CALLER's Supabase client, not the service role,
// so RLS ("credit_own" / "loads_own") is what scopes the result to their own
// account. There is no user id in the request for exactly that reason.
export async function GET() {
  const session = await getSessionUser();
  if (!session) return unauthorized();
  const { supabase, profile } = session;

  const { data: tx, error } = await supabase
    .from("credit_transactions")
    .select("id,amount_cents,kind,load_id,note,created_at")
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // credit_transactions.load_id has no foreign key to loads, so PostgREST
  // cannot embed the row. Fetch the referenced loads in one go and stitch,
  // rather than issuing a query per line.
  const ids = [...new Set((tx || []).map((t) => t.load_id).filter(Boolean))];
  let loadsById = new Map();
  if (ids.length) {
    const { data: loads } = await supabase
      .from("loads")
      .select("id,truck_number,samsara_url,destination,name,kind,arrived_at")
      .in("id", ids);
    loadsById = new Map((loads || []).map((l) => [l.id, l]));
  }

  const entries = (tx || []).map((t) => {
    const l = t.load_id ? loadsById.get(t.load_id) : null;
    return {
      id: t.id,
      at: t.created_at,
      amount_cents: t.amount_cents,
      kind: t.kind,
      // The load may have been cleared since it was billed, which is why the
      // note carries the truck and destination as text at charge time. Live
      // load data is preferred when it still exists; the note is the fallback,
      // never the other way round.
      truck: l?.truck_number || (l?.samsara_url ? "Shared truck" : null),
      destination: l?.destination || l?.name || null,
      stop: l ? (l.kind === "pickup" ? "PU" : "DEL") : null,
      note: t.note || null,
    };
  });

  // Month-by-month spend, newest first. Computed here rather than in the
  // browser so the numbers in the panel and any future statement agree.
  const byMonth = new Map();
  for (const e of entries) {
    if (e.amount_cents >= 0) continue;
    const key = String(e.at).slice(0, 7); // YYYY-MM
    const m = byMonth.get(key) || { month: key, spent_cents: 0, loads: 0 };
    m.spent_cents += -e.amount_cents;
    m.loads += 1;
    byMonth.set(key, m);
  }

  return Response.json({
    balance_cents: profile?.balance_cents ?? 0,
    entries,
    months: [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month)),
    truncated: entries.length >= LIMIT,
  });
}
