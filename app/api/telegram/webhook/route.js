import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { getSupabase } from "../../../../lib/supabase";
import { sendTelegramMessage, telegramWebhookSecret } from "../../../../lib/telegram";
import { parseLoadMessage } from "../../../../lib/groq";
import { looksLikeShareUrl } from "../../../../lib/shareLink";
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
    if (update.callback_query) {
      await handleCallback(update.callback_query, new URL(req.url).origin);
      return Response.json({ ok: true });
    }
    const message = update.message;
    const chatId = message?.chat?.id;
    if (!chatId || message?.chat?.type !== "private") return Response.json({ ok: true });
    const match = String(message?.text || "").match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{20,64})/);
    if (match) return connectChat(chatId, match[1]);

    const text = String(message?.text || message?.caption || "").trim();
    if (!text || /^\/(?:start|help)(?:\s|$)/i.test(text)) {
      await sendTelegramMessage(
        chatId,
        "A plain /start does not connect your account. Open the one-time link from TruckOn Settings and press Start there. Once connected, paste a complete load message here to add its PU/DEL stops."
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
    await sendTelegramMessage(chatId, "This Telegram account is already connected to a different TruckOn account. Disconnect it there before linking it here.");
    return Response.json({ ok: true });
  }
  if (updateError) throw updateError;

  await sendTelegramMessage(
    chatId,
    "TruckOn.site is connected. Paste a load message here to add its pickup and delivery stops to your board."
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
    await sendTelegramMessage(
      chatId,
      "This Telegram account is not connected to a TruckOn user. Sign in to TruckOn, open Settings, and choose Connect Telegram first."
    );
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
    const shareUrl = stop.samsaraUrl && looksLikeShareUrl(stop.samsaraUrl) ? stop.samsaraUrl : null;
    const truckNumber = !shareUrl ? stop.truckNumber : null;
    const trackable = !!(shareUrl || truckNumber) && !!stop.deadline;
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
      alert_enabled: true,
      telegram_enabled: false,
      telegram_interval_minutes: 0,
      telegram_next_at: null,
      telegram_pending_status: null,
      status: "unknown",
      status_note: null,
      next_check_at: trackable ? now : null,
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
  if (sourceMissing) {
    reply += " Reply with the truck number or Samsara Live Share link for these stops.";
  } else {
    reply += " Choose how often you want Telegram updates, or press Update now.";
  }
  if (omitted > 0) reply += ` The board limit was reached; ${omitted} stop${omitted === 1 ? " was" : "s were"} not added.`;
  try {
    await sendTelegramMessage(
      chatId,
      reply,
      sourceMissing ? {} : { reply_markup: groupKeyboard(groupId) }
    );
  } catch (e) {
    console.warn("Telegram import confirmation failed:", e.message);
  }
  return Response.json({ ok: true, added: rows.length });
}

function groupKeyboard(groupId) {
  return {
    inline_keyboard: [
      [
        { text: "Off", callback_data: `freq:${groupId}:0` },
        { text: "30 min", callback_data: `freq:${groupId}:30` },
        { text: "1 hour", callback_data: `freq:${groupId}:60` },
      ],
      [
        { text: "2 hours", callback_data: `freq:${groupId}:120` },
        { text: "3 hours", callback_data: `freq:${groupId}:180` },
      ],
      [{ text: "Update now", callback_data: `update:${groupId}` }],
    ],
  };
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
  if (!profile.telegram_pending_group_expires_at || new Date(profile.telegram_pending_group_expires_at) < new Date()) {
    return false;
  }

  let source = text.trim();
  const shareUrl = /^https?:\/\//i.test(source);
  if (!shareUrl) {
    source = source.replace(/^truck(?:\s*(?:number|#)\s*)?/i, "").replace(/^#\s*/, "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,29}$/.test(source)) return false;
  } else if (!looksLikeShareUrl(source)) {
    await sendTelegramMessage(chatId, "That link does not look like a Samsara Live Share URL. Send a truck number or a full Live Share link.");
    return true;
  }

  const groupId = profile.telegram_pending_group_id;
  const now = new Date().toISOString();
  const { data: loads, error: loadError } = await supabase
    .from("loads")
    .select("id,deadline,telegram_interval_minutes")
    .eq("user_id", profile.id)
    .eq("telegram_group_id", groupId)
    .is("deleted_at", null);
  if (loadError) throw loadError;
  if (!loads?.length) return false;

  const patch = {
    truck_number: shareUrl ? null : source,
    samsara_url: shareUrl ? source : null,
    status: "unknown",
    status_note: null,
    alerted: false,
    telegram_pending_status: null,
    eta_iso: null,
    eta_display: null,
    truck_at: null,
    miles_left: null,
    fail_count: 0,
    next_check_at: now,
    updated_at: now,
    telegram_next_at: Number(loads[0].telegram_interval_minutes) > 0
      ? new Date(Date.now() + Number(loads[0].telegram_interval_minutes) * 60 * 1000).toISOString()
      : null,
  };
  const { error: updateError } = await supabase
    .from("loads")
    .update(patch)
    .eq("user_id", profile.id)
    .eq("telegram_group_id", groupId);
  if (updateError) throw updateError;
  const { error: clearPendingError } = await supabase
    .from("profiles")
    .update({ telegram_pending_group_id: null, telegram_pending_group_expires_at: null })
    .eq("id", profile.id)
    .eq("telegram_pending_group_id", groupId);
  if (clearPendingError) throw clearPendingError;

  await sendTelegramMessage(
    chatId,
    `${shareUrl ? "Samsara Live Share link" : `Truck #${source}`} attached to ${loads.length} stop${loads.length === 1 ? "" : "s"}. Choose an update frequency or press Update now.`,
    { reply_markup: groupKeyboard(groupId) }
  );
  return true;
}

async function handleCallback(callback, origin) {
  const chatId = callback.message?.chat?.id;
  await telegramApi("answerCallbackQuery", { callback_query_id: callback.id });
  if (!chatId || callback.message?.chat?.type !== "private") return;

  const match = String(callback.data || "").match(/^(freq|update):([0-9a-f-]{36})(?::(0|30|60|120|180))?$/i);
  if (!match) return;
  const [, action, groupId, minuteText] = match;
  const supabase = getSupabase();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("telegram_chat_id", String(chatId))
    .maybeSingle();
  if (error) throw error;
  if (!profile) {
    await sendTelegramMessage(chatId, "Connect this Telegram account in TruckOn Settings before using load controls.");
    return;
  }

  const { data: loads, error: loadsError } = await supabase
    .from("loads")
    .select("id,position,name,kind,deadline,truck_number,samsara_url,status")
    .eq("user_id", profile.id)
    .eq("telegram_group_id", groupId)
    .is("deleted_at", null)
    .order("position", { ascending: true });
  if (loadsError) throw loadsError;
  if (!loads?.length) {
    await sendTelegramMessage(chatId, "Those load controls expired or the stops were removed. Send the load message again.");
    return;
  }

  if (action === "freq") {
    const minutes = Number(minuteText);
    const now = new Date();
    const { error: updateError } = await supabase
      .from("loads")
      .update({
        telegram_enabled: minutes > 0,
        telegram_interval_minutes: minutes,
        telegram_next_at: minutes > 0 ? new Date(now.getTime() + minutes * 60 * 1000).toISOString() : null,
      })
      .eq("user_id", profile.id)
      .eq("telegram_group_id", groupId);
    if (updateError) throw updateError;
    const cadence = minutes === 0
      ? "Telegram updates turned off."
      : `Telegram updates set to every ${minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? "" : "s"}`}.`;
    await sendTelegramMessage(chatId, `${cadence} Saved for ${loads.length} stop${loads.length === 1 ? "" : "s"}. You can change it below or press Update now.`, { reply_markup: groupKeyboard(groupId) });
    return;
  }

  await sendTelegramMessage(chatId, "Checking these stops now. I will send the results here shortly.");
  await updateGroupNow(chatId, profile.id, groupId, loads, origin);
}

async function updateGroupNow(chatId, userId, groupId, loads, origin) {
  const eligible = loads.filter((load) => load.deadline && (load.truck_number || load.samsara_url) && load.status !== "arrived");
  if (!eligible.length) {
    await sendTelegramMessage(chatId, "Add a truck number or Samsara Live Share link first. Stops without an appointment cannot be checked.");
    return;
  }
  const now = new Date().toISOString();
  const ids = eligible.map((load) => load.id);
  const supabase = getSupabase();
  const { error } = await supabase
    .from("loads")
    .update({ next_check_at: now })
    .eq("user_id", userId)
    .eq("telegram_group_id", groupId)
    .in("id", ids);
  if (error) throw error;

  const checkUrl = new URL("/api/check", origin);
  if (process.env.CHECK_SECRET) checkUrl.searchParams.set("key", process.env.CHECK_SECRET);
  checkUrl.searchParams.set("load_ids", ids.join(","));
  const response = await fetch(checkUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) {
    await sendTelegramMessage(chatId, `Update could not run (${response.status}). Please try again later.`);
    return;
  }

  const { data: refreshed, error: readError } = await supabase
    .from("loads")
    .select("id,position,name,kind,destination,status,status_note,eta_display,truck_at,miles_left,telegram_interval_minutes")
    .eq("user_id", userId)
    .eq("telegram_group_id", groupId)
    .in("id", ids)
    .order("position", { ascending: true });
  if (readError) throw readError;
  const reports = (refreshed || []).map((load) => {
    const label = load.name || `${load.kind === "pickup" ? "Pickup" : "Delivery"} stop ${load.position + 1}`;
    const status = load.status === "on_time" ? "On time" : load.status === "late" ? "Late" : load.status === "arrived" ? "Arrived" : load.status === "error" ? "Tracking issue" : "Checking";
    return [
      label,
      `Status: ${status}`,
      load.eta_display ? `ETA: ${load.eta_display}` : null,
      load.truck_at ? `Current location: ${load.truck_at}` : null,
      typeof load.miles_left === "number" ? `${Math.round(load.miles_left)} miles left` : null,
      load.status_note ? `Details: ${load.status_note}` : null,
    ].filter(Boolean).join("\n");
  });
  await sendTelegramMessage(chatId, `TruckOn update now:\n\n${reports.join("\n\n")}`);
  const sentAt = Date.now();
  for (const load of refreshed || []) {
    const interval = Number(load.telegram_interval_minutes) || 0;
    await supabase
      .from("loads")
      .update({
        telegram_pending_status: null,
        telegram_last_sent_at: new Date(sentAt).toISOString(),
        telegram_next_at:
          load.status === "arrived" || interval <= 0
            ? null
            : new Date(sentAt + interval * 60 * 1000).toISOString(),
      })
      .eq("user_id", userId)
      .eq("id", load.id);
  }
}

function sameSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}