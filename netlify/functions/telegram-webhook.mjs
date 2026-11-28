// Telegram bot webhook: POST /api/telegram (see netlify/lib/telegram.mjs for setup).
//
// Telegram posts every message sent to the bot here. Photos and descriptions of food go
// to the background job (telegram-background.mjs), since Gemini can take longer than a
// normal function may run; ↩️ Undo taps are handled here straight away.

import { getStore } from "@netlify/blobs";
import { json, updateDoc } from "../lib/shared-doc.mjs";
import { notifyChange } from "../lib/notify.mjs";
import { HELP, esc, internalToken, personFor, reply, sameSecret, telegramConfigured, tg } from "../lib/telegram.mjs";
import { FITNESS_KEY, applyOp, defaultDoc, normalize } from "./fitness.mjs";

export const telegramStore = () => getStore({ name: "telegram", consistency: "strong" });

async function undo(query) {
  const answer = (text) => tg("answerCallbackQuery", { callback_query_id: query.id, text }).catch(() => {});
  const who = personFor(query.from?.id);
  const token = String(query.data ?? "").slice(5);
  const saved = who && token ? await telegramStore().get(`undo/${token}`, { type: "json" }) : null;
  if (!saved || saved.chat !== query.message?.chat?.id) return answer("That can't be undone any more.");

  let removed = 0;
  for (const id of saved.ids) {
    const doc = await updateDoc({ key: FITNESS_KEY, defaultDoc, normalize, by: who, mutate: (d) => applyOp(d, { op: "deleteFood", id }, who) });
    if (doc) {
      removed++;
      await notifyChange(FITNESS_KEY, { op: "deleteFood", id }, who, doc).catch(() => {});
    }
  }
  await telegramStore().delete(`undo/${token}`);
  await tg("editMessageText", {
    chat_id: saved.chat, message_id: query.message.message_id, parse_mode: "HTML",
    text: `↩️ <s>${esc(saved.summary)}</s>\nUndone: removed from ${esc(saved.person)}'s diary.`,
  }).catch(() => {});
  return answer(removed ? "Removed from the diary" : "It was already gone");
}

async function startBackground(siteUrl, update) {
  const res = await fetch(new URL("/.netlify/functions/telegram-background", siteUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": internalToken() },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error(`Couldn't start the background job (${res.status})`);
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!telegramConfigured() || !sameSecret(req.headers.get("x-telegram-bot-api-secret-token"), process.env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("Not found", { status: 404 });
  }
  const update = await req.json().catch(() => null);
  if (!update) return json({ ok: true });

  if (update.callback_query) {
    if (String(update.callback_query.data ?? "").startsWith("undo:")) await undo(update.callback_query);
    return json({ ok: true });
  }

  const msg = update.message;
  if (!msg?.chat || !msg.from) return json({ ok: true }); // edits, channel posts, etc.
  const person = personFor(msg.from.id);
  if (!person) {
    // Not set up yet: tell them their id so it can be added to TELEGRAM_USERS.
    await reply(msg.chat.id, `Hi! This bot logs food to a private diary. To use it, add your Telegram id <code>${msg.from.id}</code> to <code>TELEGRAM_USERS</code> on Netlify, e.g. <code>${msg.from.id}:YourName</code>.`);
    return json({ ok: true });
  }

  const text = String(msg.text ?? msg.caption ?? "").trim();
  const image = msg.photo?.length || String(msg.document?.mime_type ?? "").startsWith("image/");
  if (!image && (!text || /^\/(start|help)\b/i.test(text))) {
    await reply(msg.chat.id, `Hi ${esc(person)}! ${esc(HELP)}`);
    return json({ ok: true });
  }

  await startBackground(req.url, update); // a failure here returns 500, so Telegram retries
  return json({ ok: true });
};

export const config = { path: "/api/telegram" };
