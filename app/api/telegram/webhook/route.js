import { createHash, timingSafeEqual } from "node:crypto";
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

  const sourceMissing = rows.some((row) => !row.truck_number && !row.samsara_url);
  const omitted = stops.length - rows.length;
  let reply = `Added ${rows.length} stop${rows.length === 1 ? "" : "s"} to your TruckOn board.`;
  if (sourceMissing) reply += " Add the truck number or Samsara Live Share link on the board so tracking can start.";
  if (rows.length) reply += " Choose a Telegram update frequency for each stop on the board.";
  if (omitted > 0) reply += ` The board limit was reached; ${omitted} stop${omitted === 1 ? " was" : "s were"} not added.`;
  try {
    await sendTelegramMessage(chatId, reply);
  } catch (e) {
    console.warn("Telegram import confirmation failed:", e.message);
  }
  return Response.json({ ok: true, added: rows.length });
}

function sameSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}