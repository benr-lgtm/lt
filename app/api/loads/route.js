import { getSessionUser, unauthorized } from "../../../lib/supabaseServer";
import { looksLikeShareUrl, shareLinkProblem } from "../../../lib/shareLink";
import { tzFromCoords } from "../../../lib/samsara";
import { MAX_ROWS } from "../../../lib/rows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Deadlines are wall-clock times in the DESTINATION's timezone — a 09:00
// appointment means 09:00 where the receiver is, not where the dispatcher is
// sitting. That is the correct semantic, but it is invisible in the UI, so
// someone entering times against an Eastern clock for an Amarillo delivery is
// silently an hour out. Attaching the zone here lets the table label the field.
//
// tz-lookup is an offline coordinate lookup, so this costs no API quota.
function withTz(loads) {
  return (loads || []).map((l) => ({
    ...l,
    dest_tz: tzFromCoords(l.dest_lat, l.dest_lng),
  }));
}

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
    loads: withTz(data),
    // Return the whole profile (minus the token ciphertext) rather than a
    // hand-picked subset. The subset was a trap: Settings is populated from this
    // payload, so every field missing here rendered blank and then got SAVED
    // blank — which is how the registered email vanished from Settings and how
    // the extra recipient addresses would have been wiped on the next save.
    // It's the caller's own row under RLS, so there is nothing to withhold
    // except the ciphertext.
    profile: publicProfile(profile),
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
    // MAX_ROWS is the default cap; profiles.max_rows lets an admin lower it.
    // The UI enforces this too, but the UI is not a security boundary.
    const maxRows = profile?.max_rows ?? MAX_ROWS;

    const { data: existing } = await supabase.from("loads").select("*");
    const byPos = new Map((existing || []).map((r) => [r.position, r]));

    const upserts = [];
    const deletions = [];
    const linkErrors = [];
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
      // Absent means "not sent by an older client", which must not silently
      // disable alerting — only an explicit false turns it off.
      const alert_enabled = r.alert_enabled !== false;
      const checkin_enabled = !!r.checkin_enabled;

      const source = (r.source || "").trim();
      const isLink = source && looksLikeShareUrl(source);
      const truck_number = source && !isLink ? source : null;
      const samsara_url = isLink ? source : null;

      // A link that can't be read is caught HERE, not on the first check.
      // Previously any string starting with http was accepted, stored, and
      // scheduled — so a truncated paste or another provider's link looked
      // saved, then failed half an hour later with the reason buried in a row
      // tooltip, and retried every 30 minutes forever after that.
      const linkProblem = isLink ? shareLinkProblem(source) : null;
      if (linkProblem) linkErrors.push({ row: position + 1, message: linkProblem });

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

      // Trackable means "has somewhere to look and something to be late for".
      // Note there is no affordability test any more: billing happens on
      // completion and the balance is allowed to go negative, so money can
      // never be the reason a load silently stops being watched. A broken link
      // is different: there is genuinely nowhere to look, so it is not
      // scheduled at all rather than scheduled and failing.
      const trackable = !!((truck_number || samsara_url) && deadline) && !linkProblem;

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
        alert_enabled,
        checkin_enabled,
        checkin_due_at: null,
        updated_at: new Date().toISOString(),
      };

      // Every row in a bulk upsert must carry the SAME key set: PostgREST
      // inserts the union of columns across all rows and NULLs the gaps, so a
      // partial key set on one row silently wipes columns on the others.
      if (changed) {
        Object.assign(row, {
          status: linkProblem ? "error" : "unknown",
          status_note: linkProblem,
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
          next_check_at: trackable ? new Date().toISOString() : null,
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
      // Same reasoning as GET: the client replaces its whole profile object with
      // this, so a narrow select here would silently blank the recipient fields
      // in the UI after an ordinary table save.
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    return Response.json({
      loads: withTz(data),
      profile: publicProfile(fresh),
      // Reported alongside a successful save rather than as a failure: the rest
      // of the table saved fine, and the user needs to know which row to fix.
      linkErrors,
    });
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

// Everything except the encrypted Samsara token, which must never reach the
// browser — only whether one is stored.
function publicProfile(p) {
  if (!p) return null;
  const { samsara_token_enc, ...rest } = p;
  return { ...rest, has_samsara_token: !!samsara_token_enc };
}
