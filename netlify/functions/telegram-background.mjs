// Background job for the Telegram bot (see netlify/lib/telegram.mjs): Gemini works out a
// meal's nutrition from the photo or description, it's logged to the person's food diary,
// and the bot replies with the breakdown, what's left for the day and an ↩️ Undo button.
// Netlify runs "*-background" functions for up to 15 minutes. Only telegram-webhook can
// start it.

import { randomBytes } from "node:crypto";
import { liveStore, updateDoc } from "../lib/shared-doc.mjs";
import { notifyChange } from "../lib/notify.mjs";
import { geminiMeal } from "../lib/gemini.mjs";
import { downloadFile, esc, internalToken, personFor, reply, sameSecret, tg } from "../lib/telegram.mjs";
import { FITNESS_KEY, applyOp, defaultDoc, normalize } from "./fitness.mjs";
import { diary } from "./mcp.mjs";
import { telegramStore } from "./telegram-webhook.mjs";

const TZ = "Asia/Singapore";
const dayIn = (offsetDays = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + offsetDays * 86_400_000));

// Same split as the app: before 11 breakfast, before 3 pm lunch, before 6 pm snacks, then dinner.
function mealByTime() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(new Date()));
  return h < 11 ? "breakfast" : h < 15 ? "lunch" : h < 18 ? "snacks" : "dinner";
}

// Meal, day and whose diary from the caption, e.g. "lunch yesterday for Lilin".
export function readCaption(text, people, sender) {
  const t = String(text ?? "").toLowerCase();
  const meal = /\bbreakfast|brekkie\b/.test(t) ? "breakfast" : /\blunch\b/.test(t) ? "lunch" : /\bdinner|supper\b/.test(t) ? "dinner" : /\bsnacks?|dessert\b/.test(t) ? "snacks" : mealByTime();
  const date = /\byesterday\b/.test(t) ? dayIn(-1) : dayIn(0);
  const other = people.find((p) => p !== sender && new RegExp(`\\bfor ${p.toLowerCase()}\\b`).test(t));
  return { meal, date, person: other ?? sender };
}

const kcal = (v) => `${Math.round(v).toLocaleString("en-US")} kcal`;
const macros = (it) => `P ${Math.round(it.protein_g)} · C ${Math.round(it.carbs_g)} · F ${Math.round(it.fat_g)}`;

export default async (req) => {
  if (!sameSecret(req.headers.get("x-internal-token"), internalToken())) return;
  const update = await req.json().catch(() => null);
  const msg = update?.message;
  const sender = personFor(msg?.from?.id);
  if (!msg || !sender) return;

  // Telegram resends an update if the webhook didn't answer in time: log each one once.
  const first = await telegramStore().setJSON(`seen/${update.update_id}`, { t: Date.now() }, { onlyIfNew: true });
  if (!first.modified) return;

  const chat = msg.chat.id;
  const status = await reply(chat, "🔍 Working out the calories with Gemini…", { reply_parameters: { message_id: msg.message_id } }).catch(() => null);
  const say = (text, extra = {}) => status
    ? tg("editMessageText", { chat_id: chat, message_id: status.message_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra })
    : reply(chat, text, extra);

  try {
    const text = String(msg.caption ?? msg.text ?? "");
    const fileId = msg.photo?.length ? msg.photo.at(-1).file_id : msg.document?.file_id;
    const image = fileId ? await downloadFile(fileId) : null;
    const meal = await geminiMeal({ imageBase64: image?.base64, mimeType: image?.mimeType, text });

    const stored = await liveStore().get(FITNESS_KEY, { type: "json" });
    const pre = stored ? normalize(stored) : defaultDoc();
    const where = readCaption(text, pre.people, pre.people.includes(sender) ? sender : pre.people[0]);
    const refName = "Gemini (Google Search)";
    const food = {
      name: meal.dish.slice(0, 80),
      amount: meal.items.length > 1 ? `${meal.items.length} items` : (meal.items[0].grams ? `${meal.items[0].grams} g` : "1 portion"),
      grams: Math.round(meal.items.reduce((s, it) => s + (it.grams || 0), 0)) || undefined,
      kcal: meal.totals.kcal, p: meal.totals.protein_g, c: meal.totals.carbs_g, f: meal.totals.fat_g,
      fiber: meal.items.some((it) => it.fiber_g != null) ? meal.items.reduce((s, it) => s + (it.fiber_g || 0), 0) : undefined,
      sugar: meal.items.some((it) => it.sugar_g != null) ? meal.items.reduce((s, it) => s + (it.sugar_g || 0), 0) : undefined,
      sodium: meal.items.some((it) => it.sodium_mg != null) ? Math.round(meal.items.reduce((s, it) => s + (it.sodium_mg || 0), 0)) : undefined,
      ref: meal.items.find((it) => /^https?:\/\//.test(it.source_url))?.source_url, refName,
      note: meal.note ? meal.note.slice(0, 200) : undefined,
      source: image ? "photo" : "describe",
      ingredients: meal.items.map((it) => ({
        name: it.name, grams: it.grams ?? 0, kcal: it.kcal, p: it.protein_g, c: it.carbs_g, f: it.fat_g,
        url: /^https?:\/\//.test(it.source_url) ? it.source_url : undefined, source: it.source || refName,
      })),
    };

    const before = new Set(pre.foods.map((f) => f.id));
    const body = { op: "addFoods", person: where.person, date: where.date, meal: where.meal, foods: [food] };
    const doc = await updateDoc({ key: FITNESS_KEY, defaultDoc, normalize, by: sender, mutate: (d) => applyOp(d, body, sender) });
    if (!doc) throw new Error("The diary is busy, please send it again");
    await notifyChange(FITNESS_KEY, body, sender, doc).catch(() => {});
    const ids = doc.foods.filter((f) => !before.has(f.id) && f.person === where.person && f.date === where.date).map((f) => f.id);

    const day = diary(doc, where.person, where.date);
    const summary = `${meal.dish}: ${kcal(meal.totals.kcal)}`;
    const token = randomBytes(6).toString("hex");
    await telegramStore().setJSON(`undo/${token}`, { ids, chat, person: where.person, summary, t: Date.now() });

    const lines = [
      `✅ <b>${esc(meal.dish)}</b> — <b>${kcal(meal.totals.kcal)}</b>`,
      `${macros(meal.totals)} g`,
      `Logged to ${esc(where.person)}'s ${where.meal}${where.date === dayIn(0) ? "" : ` on ${where.date}`}.`,
      "",
      ...meal.items.map((it) => `• ${esc(it.name)}${it.grams ? ` (${Math.round(it.grams)} g)` : ""}: ${kcal(it.kcal)}${it.source ? ` — ${it.source_url ? `<a href="${esc(it.source_url)}">${esc(it.source)}</a>` : esc(it.source)}` : ""}`),
      "",
      day.remaining.kcal >= 0 ? `🎯 ${kcal(day.remaining.kcal)} left today.` : `⚠️ ${kcal(-day.remaining.kcal)} over today's goal.`,
      ...(meal.confidence === "low" ? ["🤔 Gemini wasn't sure about this one: check the portions."] : []),
      ...(meal.note ? [`ℹ️ ${esc(meal.note)}`] : []),
      `<i>Wrong? Tap Undo and send it again with a caption, e.g. "200 g rice".</i>`,
    ];
    await say(lines.join("\n"), {
      reply_markup: { inline_keyboard: [[{ text: "↩️ Undo", callback_data: `undo:${token}` }, { text: "📒 Open diary", url: day.app }]] },
    });
  } catch (err) {
    console.error("Telegram food log failed:", err);
    await say(`❌ Couldn't log that: ${esc(err.message)}`).catch(() => {});
  }
};
