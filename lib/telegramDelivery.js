import { acquireCheckLease, releaseCheckLease } from "./checkLease";
import { sendTelegramLoadReport } from "./telegramReport";

export async function deliverTelegramReport(supabase, chatId, loadId, { pendingOnly = false, error = null, userId = null } = {}) {
  const lease = await acquireCheckLease(supabase, loadId);
  if (!lease) return { sent: false, busy: true };
  let messageSent = false;
  try {
    const load = lease.load;
    if (userId && load.user_id !== userId) throw new Error("Load ownership changed before its Telegram report was sent.");
    const pending = load.telegram_pending_status;
    if (pendingOnly && pending !== "late" && pending !== "arrived") return { sent: false, busy: false };
    const report = error
      ? { ...load, status: "error", status_note: error, eta_display: null, miles_left: null }
      : load;
    const status = pendingOnly ? pending : report.status;
    try {
      await sendTelegramLoadReport(chatId, report, status);
      messageSent = true;
    } catch (e) {
      console.warn("Telegram report delivery was not confirmed:", e.message);
      throw new Error("Telegram delivery was not confirmed and the report may have been sent. Check Telegram before retrying.");
    }
    const now = new Date().toISOString();
    const patch = { telegram_last_sent_at: now };
    if (pending && pending === status) {
      patch.telegram_pending_status = null;
      if (pending === "late") patch.telegram_late_notified_at = now;
      if (pending === "arrived") {
        patch.telegram_arrived_notified_at = now;
        patch.telegram_next_at = null;
      }
    }
    let update = supabase.from("loads")
      .update(patch)
      .eq("id", loadId)
      .eq("check_lease_token", lease.token);
    if (patch.telegram_pending_status === null) update = update.eq("telegram_pending_status", pending);
    const { data, error: updateError } = await update.select("id").maybeSingle();
    if (updateError || !data) {
      console.error("Could not save Telegram delivery state:", updateError?.code, updateError?.message);
      throw new Error("Telegram report was sent, but its delivery state could not be saved; retrying may duplicate it.");
    }
    return { sent: true, busy: false };
  } finally {
    try {
      await releaseCheckLease(supabase, loadId, lease.token);
    } catch (e) {
      if (messageSent) throw new Error("Telegram report was sent, but its check lease could not be released. Check before retrying.");
      throw e;
    }
  }
}
