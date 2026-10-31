import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { getSupabase } from "../../../../lib/supabase";
import { configureTelegramWebhook, sendTelegramMessage, telegramWebhookSecret } from "../../../../lib/telegram";
import { sendTelegramLoadReport } from "../../../../lib/telegramReport";
import { parseLoadMessage } from "../../../../lib/groq";
import { looksLikeShareUrl } from "../../../../lib/shareLink";
import { shareLinkProblem } from "../../../../lib/shareLink";
import { appointmentHasPassed } from "../../../../lib/dispatchTime";
import { MAX_ROWS } from "../../../../lib/rows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req) {
  const expected = telegramWebhookSecret();
  const provided = req.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!expected || !sameSecret(provided, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const update = await req.json();
    const message = update.message;
    const chatId = message?.chat?.id;
    if (!chatId || message?.chat?.type !== "private") return Response.json({ ok: true });

    const text = String(message.text || message.caption || "").trim();
    if (/^\/(?:refresh|fix)(?:@\w+)?$/i.test(text)) {
      const bot = await configureTelegramWebhook();
      await sendTelegramMessage(
        chatId,
        `Bot refreshed for ${bot.webhook?.url || "the configured TruckOn site"}. Use /updateall or the Update all button beside the message box whenever you want a fresh report.`,
        { reply_markup: updateAllKeyboard() }
      );
      return Response.json({ ok: true });
    }

    if (/^(?:update all|update all now|\/updateall|\/update)(?:@\w+)?$/i.test(text)) {
      await updateAllForUser(chatId, new URL(req.url).origin);
      return Response.json({ ok: true });
    }

    const start = text.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{20,64})/);
    if (start) return connectChat(chatId, start[1]);
    if (!text || /^\/(?:start|help)(?:\s|$)/i.test(text)) {
      await sendTelegramMessage(
        chatId,
        "To connect, open the one-time link from TruckOn Settings and press Start there. Once connected, paste a full load message here."
      );
      return Response.json({ ok: true });
    }

    if (await handleSourceReply(chatId, text)) return Response.json({ ok: true });
    return await importTelegramLoad(chatId, text);
  } catch (e) {
    console.warn("Telegram webhook failed:", e.message);
    return Response.json({ error: "webhook error" }, { status: 500 });
  }
}

function updateAllKeyboard() {
  return {
    keyboard: [[{ text: "Update all" }]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Paste a load or send Update all",
  };
}

async function connectChat(chatId, token) {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const supabase = getSupabase();
  const notBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("telegram_link_token_hash", tokenHash)
    .gt("telegram_link_token_created_at", notBefore)
    .maybeSingle();
  if (error) throw error;
  if (!profile) {
    await sendTelegramMessage(chatId, "That connection link expired. Create a new one from TruckOn Settings.");
    return Response.json({ ok: true });
  }

  const { error: updateError } = await supabase
    .from("profiles")
    .update({
      telegram_chat_id: String(chatId),
      telegram_link_token_hash: null,
      telegram_link_token_created_at: null,
    })
    .eq("id", profile.id)
    .eq("telegram_link_token_hash", tokenHash);
  if (updateError?.code === "23505") {
    await sendTelegramMessage(chatId, "This Telegram account is already connected to a different TruckOn account.");
    return Response.json({ ok: true });
  }
  if (updateError) throw updateError;

  await sendTelegramMessage(
    chatId,
    "TruckOn.site is connected. Paste a full load message here to add its stops.",
    { reply_markup: updateAllKeyboard() }
  );
  return Response.json({ ok: true });
}

async function importTelegramLoad(chatId, text) {
  const supabase = getSupabase();
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id,max_rows")
    .eq("telegram_chat_id", String(chatId))
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) {
    await sendTelegramMessage(chatId, "Connect this Telegram account in TruckOn Settings before importing loads.");
    return Response.json({ ok: true });
  }

  let stops;
  try {
    stops = await parseLoadMessage(text);
  } catch (e) {
    await sendTelegramMessage(chatId, `I couldn't read that load message: ${e.message}`);
    return Response.json({ ok: true });
  }
  if (!stops.length) {
    await sendTelegramMessage(chatId, "I couldn't find pickup or delivery stops with usable appointment or address information. Please send the full load text.");
    return Response.json({ ok: true });
  }
  const futureStops = stops.filter((stop) => !appointmentHasPassed(stop));
  const skippedPast = stops.length - futureStops.length;
  stops = futureStops;
  if (!stops.length) {
    await sendTelegramMessage(chatId, "All pickup/delivery appointment times in that dispatch have already passed, so no stops were added.");
    return Response.json({ ok: true });
  }

  const { data: current, error: loadsError } = await supabase
    .from("loads")
    .select("position")
    .eq("user_id", profile.id)
    .is("deleted_at", null);
  if (loadsError) throw loadsError;

  const maxRows = profile.max_rows ?? MAX_ROWS;
  const groupId = randomUUID();
  const used = new Set((current || []).map((row) => row.position));
  const positions = [];
  for (let position = 0; position < maxRows && positions.length < stops.length; position++) {
    if (!used.has(position)) positions.push(position);
  }
  if (!positions.length) {
    await sendTelegramMessage(chatId, `Your board is full (${maxRows} rows). Clear a row before adding another load.`);
    return Response.json({ ok: true });
  }

  const now = new Date().toISOString();
  const rows = stops.slice(0, positions.length).map((stop, index) => {
    const candidateUrl = stop.motiveUrl || stop.samsaraUrl;
    const shareUrl =
      candidateUrl && looksLikeShareUrl(candidateUrl) && !shareLinkProblem(candidateUrl)
        ? candidateUrl
        : null;
    const truckNumber = !shareUrl ? stop.truckNumber : null;
    return {
      user_id: profile.id,
      position: positions[index],
      telegram_group_id: groupId,
      load_number: stop.loadNumber || null,
      name: stop.facility,
      kind: stop.kind,
      appt_at: stop.appointmentAt || stop.deadline,
      deadline: stop.deadline || stop.appointmentAt,
      destination: stop.destination,
      notes: stop.notes,
      truck_number: truckNumber,
      samsara_url: shareUrl,
      tracking_enabled: false,
      alert_enabled: false,
      telegram_enabled: false,
      telegram_interval_minutes: 0,
      telegram_next_at: null,
      telegram_pending_status: null,
      status: "unknown",
      status_note: null,
      next_check_at: null,
      updated_at: now,
    };
  });
  const { error: insertError } = await supabase.from("loads").insert(rows);
  if (insertError) throw insertError;
  const { error: pendingError } = await supabase
    .from("profiles")
    .update({
      telegram_pending_group_id: groupId,
      telegram_pending_group_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq("id", profile.id);
  if (pendingError) throw pendingError;

  const sourceMissing = rows.some((row) => !row.truck_number && !row.samsara_url);
  const omitted = stops.length - rows.length;
  let reply = `Added ${rows.length} stop${rows.length === 1 ? "" : "s"} to your TruckOn board.`;
  if (skippedPast > 0) reply += ` Skipped ${skippedPast} stop${skippedPast === 1 ? "" : "s"} with appointment times that had passed.`;
  if (sourceMissing) reply += " Reply with the truck number or Samsara/Motive share link for these stops.";
  else reply += " Turn on Track on the website for scheduled checks, or send Update all for a one-time report.";
  if (omitted > 0) reply += ` The board limit was reached; ${omitted} stop${omitted === 1 ? " was" : "s were"} not added.`;
  await sendTelegramMessage(
    chatId,
    reply,
    { reply_markup: updateAllKeyboard() }
  );
  return Response.json({ ok: true, added: rows.length });
}

async function handleSourceReply(chatId, text) {
  const supabase = getSupabase();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id,telegram_pending_group_id,telegram_pending_group_expires_at")
    .eq("telegram_chat_id", String(chatId))
    .maybeSingle();
  if (error) throw error;
  if (!profile?.telegram_pending_group_id) return false;
  if (!profile.telegram_pending_group_expires_at || new Date(profile.telegram_pending_group_expires_at) < new Date()) return false;

  let source = text.trim();
  const isUrl = /^https?:\/\//i.test(source);
  if (!isUrl) {
    source = source.replace(/^truck(?:\s*(?:number|#)\s*)?/i, "").replace(/^#\s*/, "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,29}$/.test(source)) return false;
  } else if (!looksLikeShareUrl(source) || shareLinkProblem(source)) {
    await sendTelegramMessage(chatId, "That link does not look like a supported Samsara or Motive vehicle share URL. Send a truck number or the full share link.");
    return true;
  }

  const groupId = profile.telegram_pending_group_id;
  const { data: loads, error: loadError } = await supabase
    .from("loads")
    .select("id")
    .eq("user_id", profile.id)
    .eq("telegram_group_id", groupId)
    .is("deleted_at", null);
  if (loadError) throw loadError;
  if (!loads?.length) return false;

  const now = new Date().toISOString();
  const sourceFields = {
    truck_number: isUrl ? null : source,
    samsara_url: isUrl ? source : null,
    status: "unknown",
    status_note: null,
    alerted: false,
    telegram_pending_status: null,
    eta_iso: null,
    eta_display: null,
    truck_at: null,
    miles_left: null,
    fail_count: 0,
    updated_at: now,
  };
  const { error: trackedUpdateError } = await supabase
    .from("loads")
    .update({
      ...sourceFields,
      next_check_at: now,
    })
    .eq("user_id", profile.id)
    .eq("telegram_group_id", groupId)
    .is("deleted_at", null)
    .eq("tracking_enabled", true);
  if (trackedUpdateError) throw trackedUpdateError;
  const { error: untrackedUpdateError } = await supabase
    .from("loads")
    .update({ ...sourceFields, next_check_at: null })
    .eq("user_id", profile.id)
    .eq("telegram_group_id", groupId)
    .is("deleted_at", null)
    .eq("tracking_enabled", false);
  if (untrackedUpdateError) throw untrackedUpdateError;

  const { error: clearError } = await supabase
    .from("profiles")
    .update({ telegram_pending_group_id: null, telegram_pending_group_expires_at: null })
    .eq("id", profile.id)
    .eq("telegram_pending_group_id", groupId);
  if (clearError) throw clearError;

  await sendTelegramMessage(
    chatId,
    `${isUrl ? "Vehicle share link" : `Truck #${source}`} attached to ${loads.length} stop${loads.length === 1 ? "" : "s"}. Turn on Track on the website for scheduled checks, or send Update all for a one-time report.`,
    { reply_markup: updateAllKeyboard() }
  );
  return true;
}

async function updateAllForUser(chatId, origin) {
  const supabase = getSupabase();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("telegram_chat_id", String(chatId))
    .maybeSingle();
  if (error) throw error;
  if (!profile) {
    await sendTelegramMessage(chatId, "Connect this Telegram account in TruckOn Settings before requesting updates.");
    return;
  }

  const { data: loads, error: loadsError } = await supabase
    .from("loads")
    .select("id,deadline,truck_number,samsara_url,status")
    .eq("user_id", profile.id)
    .is("deleted_at", null);
  if (loadsError) throw loadsError;
  const ids = (loads || [])
    .filter((load) => load.status !== "arrived" && load.deadline && (load.truck_number || load.samsara_url))
    .map((load) => Number(load.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) {
    await sendTelegramMessage(chatId, "No active loads with a truck number or supported share link need an update.", { reply_markup: updateAllKeyboard() });
    return;
  }

  await sendTelegramMessage(chatId, `Checking ${ids.length} active load${ids.length === 1 ? "" : "s"} now…`, { reply_markup: updateAllKeyboard() });
  const now = new Date().toISOString();
  const { error: queueError } = await supabase
    .from("loads")
    .update({ next_check_at: now })
    .eq("user_id", profile.id)
    .in("id", ids);
  if (queueError) throw queueError;

  const checkUrl = new URL("/api/check", origin);
  if (process.env.CHECK_SECRET) checkUrl.searchParams.set("key", process.env.CHECK_SECRET);
  checkUrl.searchParams.set("load_ids", ids.join(","));
  const response = await fetch(checkUrl, { cache: "no-store", signal: AbortSignal.timeout(55000) });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    await sendTelegramMessage(chatId, `Update could not run: ${result.error || `HTTP ${response.status}`}.`, { reply_markup: updateAllKeyboard() });
    return;
  }

  const { data: refreshed, error: refreshError } = await supabase
    .from("loads")
    .select("id,position,name,load_number,kind,status,status_note,eta_display,truck_at,miles_left,motion,motion_updated_at")
    .eq("user_id", profile.id)
    .in("id", ids)
    .is("deleted_at", null)
    .order("position", { ascending: true });
  if (refreshError) throw refreshError;
  for (const load of refreshed || []) {
    await sendTelegramLoadReport(chatId, load);
  }
}

function sameSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
