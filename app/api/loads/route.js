import { getSessionUser, unauthorized } from "../../../lib/supabaseServer";
import { looksLikeShareUrl } from "../../../lib/samsaraShare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROW_COST_CENTS = 200;

// GET /api/loads -> this user's rows only (RLS also enforces it server-side).
export async function GET() {
  const session = await getSessionUser();
  if (!session) return unauthorized();
  const { supabase, profile } = session;

  const { data, error } = await supabase
    .from("loads")
    .select("*")
    .order("position", { ascending: true });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({
    loads: data || [],
    profile: {
      balance_cents: profile?.balance_cents ?? 0,
      max_rows: profile?.max_rows ?? 30,
      checkin_email_default: profile?.checkin_email_default ?? false,
      notify_email: profile?.notify_email ?? null,
      full_name: profile?.full_name ?? null,
      phone: profile?.phone ?? null,
      // Presence only — the ciphertext never leaves the server.
      has_samsara_token: !!profile?.samsara_token_enc,
    },
  });
}

// PUT /api/loads -> bulk save the table for this user.
export async function PUT(req) {
  const session = await getSessionUser();
  if (!session) return unauthorized();
  const { supabase, user, profile } = session;

  try {
    const body = await req.json();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const maxRows = profile?.max_rows ?? 30;
    const balance = profile?.balance_cents ?? 0;

    const { data: existing } = await supabase.from("loads").select("*");
    const byPos = new Map((existing || []).map((r) => [r.position, r]));

    const upserts = [];
    const deletions = [];
    let filled = 0;

    for (const r of rows) {
      const position = Number(r.position);
      if (!Number.isInteger(position) || position < 0 || position >= maxRows * 4) continue;

      const name = trim(r.name);
      const kind = r.kind === "pickup" ? "pickup" : "delivery";
      const appt_at = trim(r.appt_at);
      const deadline = trim(r.deadline) || appt_at; // alert time defaults to the appointment
      const destination = trim(r.destination);
      const notes = trim(r.notes);
      const alert_unlinked = !!r.alert_unlinked;
      const checkin_enabled = !!r.checkin_enabled;

      const source = (r.source || "").trim();
      const isLink = source && looksLikeShareUrl(source);
      const truck_number = source && !isLink ? source : null;
      const samsara_url = isLink ? source : null;

      const prev = byPos.get(position);
      const empty =
        !name && !truck_number && !samsara_url && !destination && !deadline && !appt_at && !notes;
      if (empty) {
        if (prev) deletions.push(position);
        continue;
      }

      filled++;
      // Enforce the plan's row cap server-side. The UI also blocks this, but the
      // UI is not a security boundary.
      if (filled > maxRows) break;

      // Anything that changes what we're tracking invalidates the cached result.
      const changed =
        !prev ||
        prev.truck_number !== truck_number ||
        prev.samsara_url !== samsara_url ||
        prev.destination !== destination ||
        prev.deadline !== deadline ||
        prev.kind !== kind;

      const trackable = !!((truck_number || samsara_url) && deadline);
      // A row already paid for stays scheduled; a new one needs funds.
      const paidFor = !!prev?.charged_at;
      const affordable = paidFor || balance >= ROW_COST_CENTS;

      const row = {
        user_id: user.id,
        position,
        name,
        kind,
        appt_at,
        deadline,
        alert_unlinked,
        truck_number,
        samsara_url,
        destination,
        notes,
        checkin_enabled,
        checkin_due_at: null,
        updated_at: new Date().toISOString(),
      };

      // Every row in a bulk upsert must carry the SAME key set: PostgREST
      // inserts the union of columns across all rows and NULLs the gaps, so a
      // partial key set on one row silently wipes columns on the others.
      if (changed) {
        Object.assign(row, {
          status: trackable ? (affordable ? "unknown" : "unpaid") : "unknown",
          status_note: null,
          alerted: false,
          eta_iso: null,
          eta_display: null,
          eta_provider: null,
          truck_at: null,
          last_lat: null,
          last_lng: null,
          last_place: null,
          miles_left: null,
          position_source: null,
          position_precision: null,
          link_tier: null,
          arrived_at: null,
          checkin_state: null,
          checkin_prompted_at: null,
          // Due immediately so a freshly saved row gets its first check on the
          // next cron tick rather than waiting out a tier interval.
          next_check_at: trackable && affordable ? new Date().toISOString() : null,
          charged_at: prev?.charged_at ?? null,
          cycle: prev?.cycle ?? 0,
          dest_lat: prev && prev.destination === destination ? prev.dest_lat ?? null : null,
          dest_lng: prev && prev.destination === destination ? prev.dest_lng ?? null : null,
        });
      } else {
        Object.assign(row, {
          status: prev.status ?? "unknown",
          status_note: prev.status_note ?? null,
          alerted: prev.alerted ?? false,
          eta_iso: prev.eta_iso ?? null,
          eta_display: prev.eta_display ?? null,
          eta_provider: prev.eta_provider ?? null,
          truck_at: prev.truck_at ?? null,
          last_lat: prev.last_lat ?? null,
          last_lng: prev.last_lng ?? null,
          last_place: prev.last_place ?? null,
          miles_left: prev.miles_left ?? null,
          position_source: prev.position_source ?? null,
          position_precision: prev.position_precision ?? null,
          link_tier: prev.link_tier ?? null,
          arrived_at: prev.arrived_at ?? null,
          checkin_state: prev.checkin_state ?? null,
          checkin_prompted_at: prev.checkin_prompted_at ?? null,
          next_check_at: prev.next_check_at ?? null,
          charged_at: prev.charged_at ?? null,
          cycle: prev.cycle ?? 0,
          dest_lat: prev.dest_lat ?? null,
          dest_lng: prev.dest_lng ?? null,
        });
      }
      upserts.push(row);
    }

    if (deletions.length) {
      const { error } = await supabase.from("loads").delete().in("position", deletions);
      if (error) throw error;
    }
    if (upserts.length) {
      const { error } = await supabase
        .from("loads")
        .upsert(upserts, { onConflict: "user_id,position" });
      if (error) throw error;
    }

    const { data } = await supabase
      .from("loads")
      .select("*")
      .order("position", { ascending: true });

    const { data: fresh } = await supabase
      .from("profiles")
      .select("balance_cents,max_rows,checkin_email_default")
      .eq("id", user.id)
      .maybeSingle();

    return Response.json({ loads: data || [], profile: fresh || null });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// DELETE /api/loads -> clear this user's rows (never anyone else's).
export async function DELETE() {
  const session = await getSessionUser();
  if (!session) return unauthorized();
  const { supabase } = session;
  const { error } = await supabase.from("loads").delete().gte("position", 0);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true, loads: [] });
}

function trim(v) {
  const s = (v || "").trim();
  return s || null;
}
