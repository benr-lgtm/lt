import { getSessionUser, unauthorized } from "../../../../lib/supabaseServer";
import { sendTelegramLoadReport } from "../../../../lib/telegramReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req) {
  const session = await getSessionUser();
  if (!session) return unauthorized();

  try {
    const { supabase, user } = session;
    const body = await req.json().catch(() => ({}));
    const requestedIds = Array.isArray(body.load_ids)
      ? body.load_ids
          .map((id) => Number(id))
          .filter((id) => Number.isSafeInteger(id) && id > 0)
      : null;
    if (requestedIds && (!requestedIds.length || requestedIds.length > 100)) {
      return Response.json({ error: "Invalid load_ids." }, { status: 400 });
    }

    let loadsQuery = supabase
      .from("loads")
      .select("id,position,name,load_number,status,eta_display,truck_at,miles_left,truck_number,samsara_url,deadline")
      .eq("user_id", user.id)
      .is("deleted_at", null);
    if (requestedIds) loadsQuery = loadsQuery.in("id", requestedIds);
    const { data: loads, error } = await loadsQuery;
    if (error) throw error;
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("telegram_chat_id")
      .eq("id", user.id)
      .maybeSingle();
    if (profileError) throw profileError;

    const missingTime = (loads || []).filter(
      (load) => load.status !== "arrived" && (load.truck_number || load.samsara_url) && !load.deadline
    );
    if (missingTime.length) {
      const labels = missingTime
        .map((load) => load.load_number ? `#${load.load_number}` : `row ${load.position + 1}`)
        .join(", ");
      return Response.json(
        { error: `Appointment date and time required for ${labels}. Open Stop info and enter both before updating.` },
        { status: 400 }
      );
    }

    const eligible = (loads || []).filter(
      (load) => load.status !== "arrived" && load.deadline && (load.truck_number || load.samsara_url)
    );
    const ids = eligible
      .map((load) => Number(load.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    if (!ids.length) {
      return Response.json({ checked: 0, deferred: 0, message: "No active loads with a truck number or vehicle share link need an update." });
    }

    const now = new Date().toISOString();
    const { error: queueError } = await supabase
      .from("loads")
      .update({ next_check_at: now })
      .eq("user_id", user.id)
      .in("id", ids);
    if (queueError) throw queueError;

    const checkUrl = new URL("/api/check", new URL(req.url).origin);
    if (process.env.CHECK_SECRET) checkUrl.searchParams.set("key", process.env.CHECK_SECRET);
    checkUrl.searchParams.set("load_ids", ids.join(","));
    const response = await fetch(checkUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(55000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json(
        { error: result.error || `The load check failed (${response.status}).` },
        { status: 502 }
      );
    }
    let telegramSent = 0;
    let telegramError = null;
    const completedIds = new Set((result.results || []).map((item) => Number(item.id)));
    const deferredIds = ids.filter((id) => !completedIds.has(id));
    const updated = (loads || []).filter((load) => completedIds.has(Number(load.id)));
    if (!profile?.telegram_chat_id) {
      telegramError = "Connect Telegram in Settings to receive this update.";
    } else if (updated.length) {
      const { data: fresh, error: freshError } = await supabase
        .from("loads")
        .select("id,position,name,load_number,kind,status,status_note,eta_display,truck_at,miles_left,motion,motion_updated_at,arrived_at,dest_precision")
        .eq("user_id", user.id)
        .in("id", updated.map((load) => load.id))
        .is("deleted_at", null)
        .order("position", { ascending: true });
      if (freshError) throw freshError;

      try {
        for (const load of fresh || []) {
          const outcome = (result.results || []).find((item) => Number(item.id) === Number(load.id));
          const report = outcome?.status === "error"
            ? { ...load, status: "error", status_note: outcome.error, eta_display: null, miles_left: null }
            : load;
          await sendTelegramLoadReport(profile.telegram_chat_id, report);
          telegramSent++;
        }
        const sentAt = new Date();
        for (const load of fresh || []) {
          await supabase
            .from("loads")
            .update({
              telegram_pending_status: null,
              telegram_last_sent_at: sentAt.toISOString(),
              telegram_next_at: null,
            })
            .eq("user_id", user.id)
            .eq("id", load.id);
        }
      } catch (e) {
        telegramError = e.message || "Telegram could not deliver the update.";
      }
    }
    return Response.json({
      checked: result.checked || 0,
      results: result.results || [],
      telegramSent,
      telegramError,
      deferred: deferredIds.length,
    });
  } catch (e) {
    return Response.json({ error: e.message || "Could not update loads now." }, { status: 500 });
  }
}
