import { createHash, randomBytes } from "node:crypto";
import { getSessionUser, unauthorized } from "../../../../lib/supabaseServer";
import {
  configureTelegramWebhook,
  telegramApi,
  telegramWebhookUrl,
} from "../../../../lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSessionUser();
  if (!session) return unauthorized();

  try {
    const [{ data: profile, error }, webhook] = await Promise.all([
      session.supabase
        .from("profiles")
        .select("telegram_chat_id")
        .eq("id", session.user.id)
        .maybeSingle(),
      telegramApi("getWebhookInfo", {}),
    ]);
    if (error) throw error;
    return Response.json({
      connected: !!profile?.telegram_chat_id,
      expectedUrl: telegramWebhookUrl(),
      webhookUrl: webhook.url || "",
      lastError: webhook.last_error_message || null,
      callbackUpdatesEnabled: (webhook.allowed_updates || []).includes("callback_query"),
    });
  } catch (e) {
    return Response.json({ error: e.message || "Could not read Telegram webhook status." }, { status: 503 });
  }
}

export async function POST(req) {
  const session = await getSessionUser();
  if (!session) return unauthorized();

  try {
    const body = await req.json().catch(() => ({}));
    const bot = await configureTelegramWebhook();
    if (!bot?.username) throw new Error("Telegram did not return the bot username.");

    if (body.action === "repair") {
      return Response.json({ ok: true, webhookUrl: bot.webhook?.url || "" });
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const { error } = await session.supabase
      .from("profiles")
      .update({
        telegram_link_token_hash: tokenHash,
        telegram_link_token_created_at: new Date().toISOString(),
      })
      .eq("id", session.user.id);
    if (error) throw error;

    return Response.json({
      url: `https://t.me/${bot.username}?start=${token}`,
      username: bot.username,
      webhookUrl: bot.webhook?.url || "",
    });
  } catch (e) {
    return Response.json({ error: e.message || "Could not create a Telegram link." }, { status: 500 });
  }
}

export async function DELETE() {
  const session = await getSessionUser();
  if (!session) return unauthorized();
  const { error } = await session.supabase
    .from("profiles")
    .update({
      telegram_chat_id: null,
      telegram_link_token_hash: null,
      telegram_link_token_created_at: null,
    })
    .eq("id", session.user.id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}