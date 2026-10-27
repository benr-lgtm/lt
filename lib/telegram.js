import { createHmac } from "node:crypto";

const API = "https://api.telegram.org";

export function telegramWebhookSecret() {
  if (process.env.TELEGRAM_WEBHOOK_SECRET) return process.env.TELEGRAM_WEBHOOK_SECRET;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram is not configured on the server.");
  return createHmac("sha256", token).update("truckon.site:telegram-webhook").digest("base64url");
}

export function telegramWebhookUrl() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://truckon.site";
  const url = new URL(appUrl);
  if (url.protocol !== "https:") throw new Error("NEXT_PUBLIC_APP_URL must use HTTPS.");
  return `${url.origin}/api/telegram/webhook`;
}

export async function telegramApi(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram is not configured on the server.");

  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new Error(result?.description || `Telegram request failed (${response.status}).`);
  }
  return result.result;
}

export async function configureTelegramWebhook() {
  const secret = telegramWebhookSecret();
  const url = telegramWebhookUrl();
  await telegramApi("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message"],
  });
  const [bot, webhook] = await Promise.all([
    telegramApi("getMe", {}),
    telegramApi("getWebhookInfo", {}),
  ]);
  return { ...bot, webhook };
}

export async function sendTelegramMessage(chatId, text) {
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text: String(text).slice(0, 4000),
    disable_web_page_preview: true,
  });
}