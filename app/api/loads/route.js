import { getSupabase } from "../../../lib/supabase";
import { looksLikeShareUrl } from "../../../lib/liveshare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ROWS = 30;

// GET /api/loads -> all loads ordered by row position.
export async function GET() {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("loads")
      .select("*")
      .order("position", { ascending: true });

    if (error) throw error;

    return Response.json({ loads: data || [] });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// PUT /api/loads -> bulk save the table.
// Body: { rows: [{ position, name, kind, deadline, source, destination }] }
// `source` is either a truck # (API mode) or a pasted Live Share URL (scrape mode);
// we route it to the right column automatically.
// Changing the source, destination, deadline, or kind resets status and clears
// the cached geocode so the row is re-evaluated on the next check.
export async function PUT(req) {
  try {
    const supabase = getSupabase();
    const body = await req.json();
    const rows = Array.isArray(body.rows) ? body.rows : [];

    const { data: existing } = await supabase.from("loads").select("*");
    const byPos = new Map((existing || []).map((r) => [r.position, r]));

    const upserts = [];
    for (const r of rows) {
      const position = Number(r.position);
      if (!Number.isInteger(position) || position < 0 || position >= MAX_ROWS)
        continue;
      const name = (r.name || "").trim() || null;
      const kind = r.kind === "pickup" ? "pickup" : "delivery";
      const deadline = (r.deadline || "").trim() || null;
      const destination = (r.destination || "").trim() || null;
      const notes = (r.notes || "").trim() || null;

      // Split the combined source into truck # vs Live Share URL.
      const source = (r.source || "").trim();
      const isLink = source && looksLikeShareUrl(source);
      const truck_number = source && !isLink ? source : null;
      const samsara_url = isLink ? source : null;

      const prev = byPos.get(position);
      const changed =
        !prev ||
        prev.truck_number !== truck_number ||
        prev.samsara_url !== samsara_url ||
        prev.destination !== destination ||
        prev.deadline !== deadline ||
        prev.kind !== kind;

      const row = {
        position,
        name,
        kind,
        deadline,
        truck_number,
        samsara_url,
        destination,
        notes,
        updated_at: new Date().toISOString(),
      };
      // IMPORTANT: every row in the bulk upsert must carry the SAME set of
      // keys. PostgREST inserts the union of columns across all rows and
      // fills missing keys with NULL — so if one changed row includes
      // `status` and an unchanged row doesn't, the unchanged row's status
      // gets nulled and the whole save fails the not-null constraint.
      if (changed) {
        row.status = "unknown";
        row.status_note = null;
        row.alerted = false;
        row.eta_iso = null;
        row.eta_display = null;
        row.truck_at = null;
        if (!prev || prev.destination !== destination) {
          row.dest_lat = null;
          row.dest_lng = null;
        } else {
          row.dest_lat = prev.dest_lat ?? null;
          row.dest_lng = prev.dest_lng ?? null;
        }
      } else {
        row.status = prev.status ?? "unknown";
        row.status_note = prev.status_note ?? null;
        row.alerted = prev.alerted ?? false;
        row.eta_iso = prev.eta_iso ?? null;
        row.eta_display = prev.eta_display ?? null;
        row.truck_at = prev.truck_at ?? null;
        row.dest_lat = prev.dest_lat ?? null;
        row.dest_lng = prev.dest_lng ?? null;
      }
      upserts.push(row);
    }

    if (upserts.length) {
      const { error } = await supabase
        .from("loads")
        .upsert(upserts, { onConflict: "position" });
      if (error) throw error;
    }

    const { data } = await supabase
      .from("loads")
      .select("*")
      .order("position", { ascending: true });
    return Response.json({ loads: data || [] });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
