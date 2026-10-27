import { getSessionUser, unauthorized } from "../../../../lib/supabaseServer";
import { sendTelegramMessage } from "../../../../lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req) {
  const session = await getSessionUser();
  if (!session) return unauthorized();

  try {
    const { supabase, user } = session;
    const { data: loads, error } = await supabase
      .from("loads")
      .select("id,position,name,load_number,status,status_note,eta_display,truck_at,miles_left,truck_number,samsara_url,deadline,telegram_enabled,telegram_interval_minutes")
      .eq("user_id", user.id)
      .is("deleted_at", null);
    if (error) throw error;
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("telegram_chat_id")
      .eq("id", user.id)
      .maybeSingle();
    if (profileError) throw profileError;

    const eligible = (loads || []).filter(
      (load) => load.status !== "arrived" && load.deadline && (load.truck_number || load.samsara_url)
    );
    const ids = eligible
      .map((load) => Number(load.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    if (!ids.length) {
      return Response.json({ checked: 0, deferred: 0, message: "No active loads with a truck number or Live Share link need an update." });
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
    const updated = (loads || []).filter((load) => ids.includes(Number(load.id)));
    if (!profile?.telegram_chat_id) {
      telegramError = "Connect Telegram in Settings to receive this update.";
    } else if (updated.length) {
      const { data: fresh, error: freshError } = await supabase
        .from("loads")
        .select("id,position,name,load_number,status,status_note,eta_display,truck_at,miles_left,telegram_interval_minutes")
        .eq("user_id", user.id)
        .in("id", updated.map((load) => load.id))
        .order("position", { ascending: true });
      if (freshError) throw freshError;

      const reports = (fresh || []).map((load) => {
        const title = load.load_number ? `Load #${load.load_number}` : load.name || `Stop ${load.position + 1}`;
        const status = load.status === "on_time" ? "On time" : load.status === "late" ? "Late" : load.status === "arrived" ? "Arrived" : load.status === "error" ? "Tracking issue" : "Checking";
        return [
          title,
          `Status: ${status}`,
          load.eta_display ? `ETA: ${load.eta_display}` : null,
          load.truck_at ? `Current location: ${load.truck_at}` : null,
          typeof load.miles_left === "number" ? `${Math.round(load.miles_left)} miles left` : null,
          load.status_note ? `Details: ${load.status_note}` : null,
        ].filter(Boolean).join("\n");
      });
      try {
        for (let index = 0; index < reports.length; index += 8) {
          await sendTelegramMessage(profile.telegram_chat_id, `TruckOn update now:\n\n${reports.slice(index, index + 8).join("\n\n")}`);
          telegramSent += Math.min(8, reports.length - index);
        }
        const sentAt = new Date();
        for (const load of fresh || []) {
          const interval = Number(load.telegram_interval_minutes) || 0;
          await supabase
            .from("loads")
            .update({
              telegram_pending_status: null,
              telegram_last_sent_at: sentAt.toISOString(),
              telegram_next_at:
                load.status === "arrived" || interval <= 0
                  ? null
                  : new Date(sentAt.getTime() + interval * 60 * 1000).toISOString(),
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
      deferred: result.deferred || 0,
      telegramSent,
      telegramError,
    });
  } catch (e) {
    return Response.json({ error: e.message || "Could not update loads now." }, { status: 500 });
  }
}
