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
    .is("deleted_at", null)
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

    const { data: existing, error: existingError } = await supabase
      .from("loads")
      .select("*")
      .is("deleted_at", null);
    if (existingError) throw existingError;
    const existingRows = existing || [];
    const byPos = new Map(existingRows.map((r) => [r.position, r]));
    const byId = new Map(existingRows.map((r) => [Number(r.id), r]));

    const upserts = [];
    const deletions = [];
    const linkErrors = [];
    const retainedIds = new Set();
    const submittedPositions = new Set();
    let filled = 0;

    for (const r of rows) {
      const position = Number(r.position);
      if (!Number.isInteger(position) || position < 0 || position >= maxRows * 4) continue;
      if (submittedPositions.has(position)) throw new Error("Duplicate load position.");
      submittedPositions.add(position);

      const name = trim(r.name);
      const load_number = trim(r.load_number);
      const kind = r.kind === "pickup" ? "pickup" : "delivery";
      const appt_at = trim(r.appt_at);
      const deadline = trim(r.deadline) || appt_at; // alert time defaults to the appointment
      const destination = trim(r.destination);
      const notes = trim(r.notes);
      const alert_unlinked = !!r.alert_unlinked;
      const telegram_interval_minutes = 0;
      const telegram_enabled = false;
      const tracking_enabled = r.tracking_enabled !== false;
      const alert_enabled = tracking_enabled;
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

      const requestedId = Number(r.id);
      const hasRowId = Object.prototype.hasOwnProperty.call(r, "id");
      const prev =
        Number.isSafeInteger(requestedId) && requestedId > 0
          ? byId.get(requestedId)
          : hasRowId
          ? null
          : byPos.get(position);
      const telegramIntervalChanged =
        !prev || Number(prev.telegram_interval_minutes || 0) !== telegram_interval_minutes;
      const empty =
        !name && !load_number && !truck_number && !samsara_url && !destination && !deadline && !appt_at && !notes;
      if (empty) {
        if (prev) deletions.push(prev.position);
        continue;
      }

      filled++;
      // Enforce the plan's row cap server-side. The UI also blocks this, but the
      // UI is not a security boundary.
      if (filled > maxRows) {
        if (prev) retainedIds.add(Number(prev.id));
        for (const remaining of existingRows) {
          if (remaining.position >= position) retainedIds.add(Number(remaining.id));
        }
        break;
      }

      // Anything that changes what we're tracking invalidates the cached result.
      const changed =
        !prev ||
        prev.truck_number !== truck_number ||
        prev.samsara_url !== samsara_url ||
        prev.destination !== destination ||
        prev.deadline !== deadline ||
        prev.kind !== kind;
      const trackingChanged = !prev || prev.tracking_enabled !== tracking_enabled;

      // Trackable means "has somewhere to look and something to be late for".
      // Note there is no affordability test any more: billing happens on
      // completion and the balance is allowed to go negative, so money can
      // never be the reason a load silently stops being watched. A broken link
      // is different: there is genuinely nowhere to look, so it is not
      // scheduled at all rather than scheduled and failing.
      const trackable =
        !!((truck_number || samsara_url) && deadline) &&
        !linkProblem &&
        tracking_enabled;

      const row = {
        ...(prev ? { id: prev.id } : {}),
        user_id: user.id,
        position,
        load_number,
        name,
        kind,
        appt_at,
        deadline,
        alert_unlinked,
        truck_number,
        samsara_url,
        destination,
        notes,
        tracking_enabled,
        alert_enabled,
        telegram_enabled,
        telegram_interval_minutes,
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
          telegram_pending_status: null,
          telegram_late_notified_at: null,
          telegram_arrived_notified_at: null,
          telegram_last_sent_at: null,
          telegram_next_at: telegram_enabled
            ? new Date(Date.now() + telegram_interval_minutes * 60 * 1000).toISOString()
            : null,
          // Editing the row is a fresh start: if the new link also dies, that
          // is worth another email.
          blackout_alerted: false,
          fail_count: 0,
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
          // Positional memory MUST be cleared when the destination changes.
          // closest_miles records the nearest this truck has ever been to the
          // OLD stop; carried over, the new distance would immediately exceed
          // it by the departure margin and the row would mark itself arrived
          // the first time it was checked.
          closest_miles: null,
          stopped_since: null,
          history_checked_at: null,
          // Due immediately so a freshly saved row gets its first check on the
          // next cron tick rather than waiting out a tier interval.
          next_check_at: trackable ? new Date().toISOString() : null,
          charged_at: prev?.charged_at ?? null,
          cycle: prev?.cycle ?? 0,
          motion: prev?.motion ?? null,
          motion_updated_at: prev?.motion_updated_at ?? null,
          dest_lat: prev && prev.destination === destination ? prev.dest_lat ?? null : null,
          dest_lng: prev && prev.destination === destination ? prev.dest_lng ?? null : null,
        });
      } else {
        Object.assign(row, {
          status: prev.status ?? "unknown",
          status_note: prev.status_note ?? null,
          alerted: prev.alerted ?? false,
          telegram_pending_status: telegram_enabled ? prev.telegram_pending_status ?? null : null,
          telegram_late_notified_at: prev.telegram_late_notified_at ?? null,
          telegram_arrived_notified_at: prev.telegram_arrived_notified_at ?? null,
          telegram_last_sent_at: prev.telegram_last_sent_at ?? null,
          telegram_next_at: telegram_enabled
            ? telegramIntervalChanged || !prev.telegram_next_at
              ? new Date(Date.now() + telegram_interval_minutes * 60 * 1000).toISOString()
              : prev.telegram_next_at
            : null,
          // Must appear in BOTH branches: PostgREST inserts the union of keys
          // across a bulk upsert and NULLs the gaps, so listing a column on
          // only one branch wipes it on every other row.
          blackout_alerted: prev.blackout_alerted ?? false,
          fail_count: prev.fail_count ?? 0,
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
          closest_miles: prev.closest_miles ?? null,
          stopped_since: prev.stopped_since ?? null,
          history_checked_at: prev.history_checked_at ?? null,
          next_check_at: prev.next_check_at ?? null,
          charged_at: prev.charged_at ?? null,
          cycle: prev.cycle ?? 0,
          motion: prev.motion ?? null,
          motion_updated_at: prev.motion_updated_at ?? null,
          dest_lat: prev.dest_lat ?? null,
          dest_lng: prev.dest_lng ?? null,
        });
      }
      if (!tracking_enabled) row.next_check_at = null;
      else if (trackingChanged && trackable) row.next_check_at = new Date().toISOString();
      if (!changed && prev) row.updated_at = prev.updated_at ?? row.updated_at;
      if (prev) retainedIds.add(Number(prev.id));
      upserts.push(row);
    }

    for (const row of existingRows) {
      if (!retainedIds.has(Number(row.id)) && !deletions.includes(row.position)) {
        deletions.push(row.position);
      }
    }

    // Keep retired rows available in History. Surviving rows are staged at a
    // unique negative position so their IDs and histories survive compaction.
    if (deletions.length) {
      const { error } = await supabase.rpc("retire_loads", { p_positions: deletions });
      if (error) throw error;
    }
    const updates = upserts.filter((row) => row.id);
    const inserts = upserts.filter((row) => !row.id);
    if (updates.length) {
      const positionsChanged = updates.some(
        (row) => byId.get(Number(row.id))?.position !== row.position
      );
      if (positionsChanged) {
        const { error } = await supabase.rpc("compact_load_positions", {
          p_assignments: updates.map((row) => ({ id: row.id, position: row.position })),
          p_user_id: user.id,
        });
        if (error) throw error;
      }
      const { error: updateError } = await supabase
        .from("loads")
        .upsert(updates, { onConflict: "id" });
      if (updateError) throw updateError;
    }
    if (inserts.length) {
      const { error } = await supabase.from("loads").insert(inserts);
      if (error) throw error;
    }

    const { data } = await supabase
      .from("loads")
      .select("*")
      .is("deleted_at", null)
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
  // Same as clearing one row: retired for a week, not destroyed. A null array
  // means "every live row of mine" — RLS keeps that to the caller's own rows.
  const { error } = await supabase.rpc("retire_loads", { p_positions: null });
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
  const {
    samsara_token_enc,
    telegram_link_token_hash,
    telegram_link_token_created_at,
    ...rest
  } = p;
  return { ...rest, has_samsara_token: !!samsara_token_enc };
}
