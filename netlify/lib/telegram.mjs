// Telegram bot for the food diary: send it a photo of a meal (or describe it) and Gemini
// works out the calories and logs them to your diary (see telegram-webhook.mjs and
// telegram-background.mjs).
//
// Needs, on Netlify:
//  - TELEGRAM_BOT_TOKEN: from @BotFather when you create the bot.
//  - TELEGRAM_WEBHOOK_SECRET: any long random password (letters, digits, _ and -); Telegram
//    sends it with every message so no one else can post to the webhook.
//  - TELEGRAM_USERS: whose diary each Telegram account logs to, e.g.
//    "123456789:Karstin,987654321:Lilin" (the bot tells you your id when you message it).
//  - GEMINI_API_KEY (see gemini.mjs).

import { createHash, timingSafeEqual } from "node:crypto";

export const telegramConfigured = () => Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_WEBHOOK_SECRET);

export function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Lets telegram-webhook start telegram-background, and no one else.
export function internalToken() {
  return createHash("sha256").update(`food-diary-telegram:${process.env.TELEGRAM_BOT_TOKEN}`).digest("hex");
}

// Telegram user id -> person, from TELEGRAM_USERS ("id:Name,id:Name").
export function personFor(userId) {
  for (const pair of String(process.env.TELEGRAM_USERS ?? "").split(",")) {
    const [id, name] = pair.split(":").map((s) => s.trim());
    if (id && name && id === String(userId)) return name;
  }
  return null;
}

export async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
  return data.result;
}

// Downloads a file the person sent, as base64.
export async function downloadFile(fileId) {
  const file = await tg("getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Couldn't download the photo (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = String(file.file_path).split(".").pop().toLowerCase();
  const mimeType = { png: "image/png", webp: "image/webp", heic: "image/heic" }[ext] ?? "image/jpeg";
  return { base64: buf.toString("base64"), mimeType };
}

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const reply = (chatId, text, extra = {}) =>
  tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });

export const HELP = `Send me a photo of your meal (or describe it) and I'll work out the calories with Gemini and log them to your food diary.

Add a caption to help: a weight or portion ("200 g rice", "half"), the place ("McDonald's"), the meal ("lunch") or the day ("yesterday"). Without one, the meal comes from the time of day.

Every log has an ↩️ Undo button.`;
